package app.kybl.mobile

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.Settings
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class RunNowArgs {
  var setId: String? = null
}

/**
 * The Android half of src/backup/mod.rs: photo permissions (with Android 14's "selected photos"
 * partial access and the location in photos), picking a folder to back up, and scheduling the
 * WorkManager runs (BackupWorker.kt), which do the backing up whether or not the app is open.
 */
@TauriPlugin(
  permissions = [
    // Android 14+: the dialog with "Allow all", "Select photos" and "Don't allow"
    Permission(strings = [Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED], alias = "media34"),
    Permission(strings = [Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO], alias = "media33"),
    Permission(strings = [Manifest.permission.READ_EXTERNAL_STORAGE], alias = "storage"),
    // without it Android removes the location from photos' EXIF before Kybl reads them
    Permission(strings = [Manifest.permission.ACCESS_MEDIA_LOCATION], alias = "location"),
    Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications"),
  ]
)
class BackupPlugin(private val activity: Activity) : Plugin(activity) {
  private val prefs get() = activity.getSharedPreferences("backup", Context.MODE_PRIVATE)

  override fun load(webView: WebView) {
    // the app opening counts as a reason to back up ("Backs up while Kybl is open")
    Thread {
      try {
        BackupScheduler.schedule(activity)
        if (BackupNative.sets().any { it.optBoolean("enabled", true) }) BackupScheduler.runNow(activity, null, manual = false)
      } catch (e: Throwable) {
        // backups simply wait for the next periodic run
      }
    }.start()
  }

  private fun granted(p: String) = ContextCompat.checkSelfPermission(activity, p) == PackageManager.PERMISSION_GRANTED

  /** `{photos, location, notifications, sdk}`; photos is granted, limited, denied or notDetermined. */
  private fun state(): JSObject {
    val sdk = Build.VERSION.SDK_INT
    val all = when {
      sdk >= 33 -> granted(Manifest.permission.READ_MEDIA_IMAGES)
      else -> granted(Manifest.permission.READ_EXTERNAL_STORAGE)
    }
    val partial = sdk >= 34 && !all && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
    val photos = when {
      all -> "granted"
      partial -> "limited"
      prefs.getBoolean("asked", false) -> "denied"
      else -> "notDetermined"
    }
    return JSObject().apply {
      put("photos", photos)
      put("videos", if (sdk >= 33) granted(Manifest.permission.READ_MEDIA_VIDEO) else all)
      put("location", sdk < 29 || granted(Manifest.permission.ACCESS_MEDIA_LOCATION))
      put("notifications", sdk < 33 || granted(Manifest.permission.POST_NOTIFICATIONS))
      put("sdk", sdk)
    }
  }

  private fun aliases(): Array<String> {
    val sdk = Build.VERSION.SDK_INT
    val list = mutableListOf(
      when {
        sdk >= 34 -> "media34"
        sdk >= 33 -> "media33"
        else -> "storage"
      }
    )
    if (sdk >= 29) list.add("location")
    if (sdk >= 33) list.add("notifications")
    return list.toTypedArray()
  }

  @Command
  fun permission(invoke: Invoke) {
    invoke.resolve(state())
  }

  @Command
  fun requestPermission(invoke: Invoke) {
    prefs.edit().putBoolean("asked", true).apply()
    requestPermissionForAliases(aliases(), invoke, "permissionDone")
  }

  @PermissionCallback
  fun permissionDone(invoke: Invoke) {
    Thread {
      try {
        BackupScheduler.schedule(activity)
      } catch (e: Throwable) {
      }
    }.start()
    invoke.resolve(state())
  }

  /**
   * Android 14 with "selected photos": asks again, which lets people pick more or allow all.
   * Otherwise (a refusal Android no longer asks about) Kybl's page in the system settings.
   */
  @Command
  fun manageAccess(invoke: Invoke) {
    val s = state()
    if (s.getString("photos") == "limited") {
      requestPermissionForAliases(arrayOf("media34"), invoke, "permissionDone")
      return
    }
    try {
      activity.startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
    } catch (e: Exception) {
      invoke.reject("Open Settings › Apps › Kybl › Permissions to allow photos.")
      return
    }
    invoke.resolve(s)
  }

  /** The system folder picker; the folder stays readable after restarts (a persisted grant). */
  @Command
  fun pickFolder(invoke: Invoke) {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
      Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
    )
    try {
      startActivityForResult(invoke, intent, "folderPicked")
    } catch (e: Exception) {
      invoke.reject("This phone has no folder picker.")
    }
  }

  @ActivityCallback
  fun folderPicked(invoke: Invoke, result: ActivityResult) {
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || uri == null) {
      invoke.resolve(JSObject())
      return
    }
    try {
      activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
    } catch (e: SecurityException) {
      invoke.reject("Android didn't let Kybl keep access to this folder. Try another one.")
      return
    }
    invoke.resolve(JSObject().apply {
      put("type", "androidTree")
      put("uri", uri.toString())
      put("label", label(uri))
    })
  }

  /** The folder's name as the picker showed it ("WhatsApp Images"). */
  private fun label(tree: Uri): String {
    try {
      val doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
      activity.contentResolver.query(doc, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) c.getString(0)?.let { return it }
      }
    } catch (e: Exception) {
    }
    return DocumentsContract.getTreeDocumentId(tree).substringAfterLast(':').substringAfterLast('/').ifEmpty { "Folder" }
  }

  @Command
  fun schedule(invoke: Invoke) {
    Thread {
      try {
        BackupScheduler.schedule(activity)
        invoke.resolve()
      } catch (e: Throwable) {
        invoke.reject(e.message ?: "Couldn't schedule the backup.")
      }
    }.start()
  }

  /** "Back up now" (and "Try again"). */
  @Command
  fun runNow(invoke: Invoke) {
    val args = invoke.parseArgs(RunNowArgs::class.java)
    BackupScheduler.runNow(activity, args.setId, manual = true)
    invoke.resolve()
  }
}
