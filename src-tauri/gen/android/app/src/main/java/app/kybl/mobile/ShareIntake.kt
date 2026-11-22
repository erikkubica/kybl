package app.kybl.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import androidx.core.content.IntentCompat
import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/**
 * Files shared into Kybl from other apps (the share sheet's "Kybl"). The `content://` streams
 * are only lent while the share lasts, so they are copied into the app's cache right away, under
 * their own names, and handed to Rust (src/platform.rs), which queues them for the page to pick
 * an upload destination. Sharing plain text (a note, a link) makes a .txt file of it.
 */
object ShareIntake {
  private const val TAG = "KyblShare"

  /** True if this was a share (handled, even if nothing usable came with it). */
  fun handle(activity: Activity, intent: Intent?): Boolean {
    val action = intent?.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return false
    val uris = LinkedHashSet<Uri>()
    if (action == Intent.ACTION_SEND) {
      IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { uris.add(it) }
    } else {
      IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { uris.addAll(it) }
    }
    intent.clipData?.let { clip ->
      for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris.add(it) }
    }
    // Only what another app hands over through the system. Kybl's own files (its FileProvider,
    // or plain paths) would be read with Kybl's own rights: another app could share Kybl's
    // private files back into it and have them uploaded.
    uris.retainAll { isForeign(activity, it) }
    val text = if (uris.isEmpty()) intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() else null
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
    if (uris.isEmpty() && text.isNullOrBlank()) return true

    val resolver = activity.contentResolver
    val cache = File(activity.cacheDir, "shared/${UUID.randomUUID()}")
    Thread {
      val out = JSONArray()
      uris.forEachIndexed { i, uri ->
        try {
          val name = displayName(activity, uri)
          val dest = File(File(cache, i.toString()), name)
          dest.parentFile?.mkdirs()
          val input = resolver.openInputStream(uri) ?: throw IllegalStateException("no data")
          val size = input.use { inp -> dest.outputStream().use { inp.copyTo(it) } }
          out.put(JSONObject().put("path", dest.absolutePath).put("name", name).put("size", size))
        } catch (e: Exception) {
          Log.w(TAG, "couldn't take a shared file: $uri", e)
        }
      }
      if (text != null) {
        val name = clean(subject?.take(60)?.trim().orEmpty()).ifEmpty { "Shared text" } + ".txt"
        val dest = File(File(cache, "text"), name)
        dest.parentFile?.mkdirs()
        dest.writeText(text)
        out.put(JSONObject().put("path", dest.absolutePath).put("name", name).put("size", dest.length()))
      }
      if (out.length() > 0) {
        try {
          KyblNative.sharedFiles(out.toString())
        } catch (e: Throwable) {
          Log.e(TAG, "couldn't hand shared files over", e)
        }
      }
    }.start()
    return true
  }

  /** A `content://` URI of another app's provider (not Kybl's own, not a `file://` path). */
  private fun isForeign(activity: Activity, uri: Uri): Boolean {
    if (uri.scheme != "content") {
      Log.w(TAG, "ignored a shared ${uri.scheme} URI")
      return false
    }
    val authority = uri.authority ?: return false
    val own = authority == "${activity.packageName}.fileprovider" ||
      try {
        activity.packageManager.resolveContentProvider(authority, 0)?.packageName == activity.packageName
      } catch (e: Exception) {
        false
      }
    if (own) Log.w(TAG, "ignored a shared URI of Kybl's own files")
    return !own
  }

  private fun displayName(activity: Activity, uri: Uri): String {
    var name: String? = null
    try {
      activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (c.moveToFirst() && n >= 0 && !c.isNull(n)) name = c.getString(n)
      }
    } catch (e: Exception) {
      // some apps share streams that can't be queried: the URI's last part will do
    }
    return clean(name ?: uri.lastPathSegment?.substringAfterLast('/') ?: "").ifEmpty { "file" }
  }

  /** A name that is safe as one file name. */
  private fun clean(name: String) = name.replace('/', '_').replace('\u0000', '_').trim().trimStart('.')
}
