package app.kybl.mobile

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.view.HapticFeedbackConstants
import android.view.WindowManager
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.fragment.app.FragmentActivity
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class OpenFileArgs {
  lateinit var path: String
  var mime: String? = null
}

@InvokeArg
class ShareArgs {
  var paths: List<String>? = null
  var mimes: List<String>? = null
  var text: String? = null
}

@InvokeArg
class PhotoArgs {
  lateinit var path: String
  lateinit var mime: String
}

@InvokeArg
class HapticArgs {
  var kind: String = "light"
}

@InvokeArg
class BiometricArgs {
  var reason: String = ""
}

@InvokeArg
class PrivacyArgs {
  var enabled: Boolean = false
}

/**
 * The Android half of src/platform.rs: "Open with", the share sheet, Save to Photos, haptics,
 * fingerprint / face unlock, hiding the app in the app switcher, and the storage permission
 * Android 7–10 need for the shared Download folder.
 */
@TauriPlugin(
  permissions = [Permission(strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE], alias = "storage")]
)
class PlatformPlugin(private val activity: Activity) : Plugin(activity) {
  private val authority get() = "${activity.packageName}.fileprovider"

  /**
   * A `content://` URI other apps may read. Files outside the folders FileProvider shares
   * (res/xml/file_paths.xml) are copied into the cache first.
   */
  private fun contentUri(file: File): Uri {
    return try {
      FileProvider.getUriForFile(activity, authority, file)
    } catch (e: IllegalArgumentException) {
      val copy = File(activity.cacheDir, "outgoing/${System.nanoTime()}/${file.name}")
      copy.parentFile?.mkdirs()
      file.copyTo(copy, overwrite = true)
      FileProvider.getUriForFile(activity, authority, copy)
    }
  }

  /**
   * Files Kybl may hand to other apps: its downloads, its cache and temporary copies. Anything
   * else, its private data above all (the secret keys, settings), is refused whatever path the
   * page asks for.
   */
  @Suppress("DEPRECATION")
  private fun shareable(file: File): Boolean {
    val path = try {
      file.canonicalPath
    } catch (e: Exception) {
      return false
    }
    val publicDownloads = try {
      File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Kybl")
    } catch (e: Exception) {
      null
    }
    val roots = listOfNotNull(
      activity.cacheDir,
      activity.externalCacheDir,
      activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
      File(activity.filesDir, "Downloads"),
      publicDownloads,
    )
    return roots.any { root ->
      val r = try {
        root.canonicalPath
      } catch (e: Exception) {
        null
      }
      r != null && path.startsWith(r + File.separator)
    }
  }

  private fun notShareable(file: File) = "${file.name} isn't one of Kybl's downloads, so it can't be handed to another app."

  @Command
  fun openFile(invoke: Invoke) {
    val args = invoke.parseArgs(OpenFileArgs::class.java)
    val file = File(args.path)
    if (!shareable(file)) {
      invoke.reject(notShareable(file))
      return
    }
    try {
      val uri = contentUri(file)
      val view = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, args.mime ?: "application/octet-stream")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      if (activity.packageManager.queryIntentActivities(view, 0).isEmpty()) {
        invoke.reject("No app on this phone can open ${file.name}.")
        return
      }
      val chooser = Intent.createChooser(view, "Open with").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      activity.runOnUiThread {
        try {
          activity.startActivity(chooser)
          invoke.resolve()
        } catch (e: ActivityNotFoundException) {
          invoke.reject("No app on this phone can open ${file.name}.")
        }
      }
    } catch (e: Exception) {
      invoke.reject("Couldn't open ${file.name}: ${e.message}")
    }
  }

  @Command
  fun share(invoke: Invoke) {
    val args = invoke.parseArgs(ShareArgs::class.java)
    try {
      val paths = args.paths.orEmpty()
      paths.map { File(it) }.firstOrNull { !shareable(it) }?.let {
        invoke.reject(notShareable(it))
        return
      }
      val send = if (paths.isEmpty()) {
        Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, args.text ?: "")
      } else {
        val uris = ArrayList(paths.map { contentUri(File(it)) })
        val intent = if (uris.size == 1) {
          Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris[0])
        } else {
          Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
        }
        // the grant reaches the app picked in the chooser through the clip data
        val clip = ClipData.newRawUri(null, uris[0])
        uris.drop(1).forEach { clip.addItem(ClipData.Item(it)) }
        intent.clipData = clip
        intent.setType(commonType(args.mimes.orEmpty())).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val chooser = Intent.createChooser(send, null).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      activity.runOnUiThread {
        try {
          activity.startActivity(chooser)
          invoke.resolve()
        } catch (e: ActivityNotFoundException) {
          invoke.reject("No app on this phone can share this.")
        }
      }
    } catch (e: Exception) {
      invoke.reject("Couldn't share: ${e.message}")
    }
  }

  // "image/jpeg" + "image/png" → "image/*"; a photo and a PDF → any type
  private fun commonType(mimes: List<String>): String {
    if (mimes.isEmpty()) return "*/*"
    if (mimes.all { it == mimes[0] }) return mimes[0]
    val top = mimes[0].substringBefore('/')
    return if (mimes.all { it.substringBefore('/') == top }) "$top/*" else "*/*"
  }

  /**
   * Into Pictures/Kybl or Movies/Kybl. Android 10+ through MediaStore, which needs no
   * permission; older versions write the file and have the media scanner pick it up, which
   * needs the storage permission.
   */
  @Command
  fun saveToPhotos(invoke: Invoke) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("storage") != PermissionState.GRANTED) {
      requestPermissionForAlias("storage", invoke, "photosPermission")
      return
    }
    savePhoto(invoke)
  }

  @PermissionCallback
  fun photosPermission(invoke: Invoke) {
    if (getPermissionState("storage") == PermissionState.GRANTED) {
      savePhoto(invoke)
    } else {
      invoke.reject("Kybl needs access to your phone's storage to save to your photos.")
    }
  }

  private fun savePhoto(invoke: Invoke) {
    val args = invoke.parseArgs(PhotoArgs::class.java)
    val file = File(args.path)
    if (!shareable(file)) {
      invoke.reject(notShareable(file))
      return
    }
    val video = args.mime.startsWith("video/")
    Thread {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) saveWithMediaStore(file, args.mime, video) else saveLegacy(file, args.mime, video)
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject("Couldn't save ${file.name} to your photos: ${e.message}")
      }
    }.start()
  }

  private fun saveWithMediaStore(file: File, mime: String, video: Boolean) {
    val resolver = activity.contentResolver
    val collection = if (video) {
      MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    } else {
      MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    }
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
      put(MediaStore.MediaColumns.MIME_TYPE, mime)
      put(MediaStore.MediaColumns.RELATIVE_PATH, (if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES) + "/Kybl")
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val item = resolver.insert(collection, values) ?: throw IllegalStateException("the gallery didn't take it")
    try {
      val out = resolver.openOutputStream(item) ?: throw IllegalStateException("the gallery didn't take it")
      out.use { o -> file.inputStream().use { it.copyTo(o) } }
      resolver.update(item, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
    } catch (e: Exception) {
      resolver.delete(item, null, null)
      throw e
    }
  }

  @Suppress("DEPRECATION")
  private fun saveLegacy(file: File, mime: String, video: Boolean) {
    val dir = File(Environment.getExternalStoragePublicDirectory(if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES), "Kybl")
    if (!dir.isDirectory && !dir.mkdirs()) throw IllegalStateException("no room in shared storage")
    var dest = File(dir, file.name)
    var n = 1
    while (dest.exists()) {
      dest = File(dir, "${file.nameWithoutExtension} ($n)${if (file.extension.isEmpty()) "" else "." + file.extension}")
      n++
    }
    file.copyTo(dest)
    MediaScannerConnection.scanFile(activity, arrayOf(dest.absolutePath), arrayOf(mime), null)
  }

  /** Android 7–10: the permission to write to the shared Download folder. `{granted}` */
  @Command
  fun askStorage(invoke: Invoke) {
    if (Build.VERSION.SDK_INT >= 30 || getPermissionState("storage") == PermissionState.GRANTED) {
      invoke.resolve(JSObject().put("granted", true))
      return
    }
    requestPermissionForAlias("storage", invoke, "storagePermission")
  }

  @PermissionCallback
  fun storagePermission(invoke: Invoke) {
    invoke.resolve(JSObject().put("granted", getPermissionState("storage") == PermissionState.GRANTED))
  }

  @Command
  fun haptic(invoke: Invoke) {
    val args = invoke.parseArgs(HapticArgs::class.java)
    val r = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
    val effect = when (args.kind) {
      "selection" -> HapticFeedbackConstants.CLOCK_TICK
      "light" -> HapticFeedbackConstants.KEYBOARD_TAP
      "medium" -> HapticFeedbackConstants.VIRTUAL_KEY
      "success" -> if (r) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
      "warning" -> HapticFeedbackConstants.LONG_PRESS
      "error" -> if (r) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
      else -> HapticFeedbackConstants.KEYBOARD_TAP
    }
    activity.runOnUiThread {
      // follows the system's "touch feedback" setting
      activity.window?.decorView?.performHapticFeedback(effect)
      invoke.resolve()
    }
  }

  /** Fingerprint / face, or the screen lock's PIN or pattern. `{ok: false}` when cancelled. */
  @Command
  fun biometric(invoke: Invoke) {
    val args = invoke.parseArgs(BiometricArgs::class.java)
    val fragments = activity as? FragmentActivity
    if (fragments == null) {
      invoke.reject("Unlocking isn't available right now.")
      return
    }
    val allowed = BIOMETRIC_WEAK or DEVICE_CREDENTIAL
    if (BiometricManager.from(activity).canAuthenticate(allowed) != BiometricManager.BIOMETRIC_SUCCESS) {
      invoke.reject("Set up a screen lock on this phone to lock Kybl.")
      return
    }
    activity.runOnUiThread {
      val prompt = BiometricPrompt(fragments, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          invoke.resolve(JSObject().put("ok", true))
        }

        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
          invoke.resolve(JSObject().put("ok", false))
        }
      })
      prompt.authenticate(
        BiometricPrompt.PromptInfo.Builder()
          .setTitle("Unlock Kybl")
          .setSubtitle(args.reason.ifEmpty { null })
          .setAllowedAuthenticators(allowed)
          .build()
      )
    }
  }

  /** App lock on: a blank card in the app switcher, and no screenshots. */
  @Command
  fun privacyScreen(invoke: Invoke) {
    val args = invoke.parseArgs(PrivacyArgs::class.java)
    MainActivity.privacy = args.enabled
    activity.runOnUiThread {
      if (args.enabled) {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      } else {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
      invoke.resolve()
    }
  }
}
