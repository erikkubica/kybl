package app.kybl.mobile

import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/**
 * The Rust backup engine (src/backup/headless.rs), callable from a WorkManager worker with or
 * without the app's screen: WorkManager may start the process with no Activity, and then this is
 * the first thing that loads the Rust library. Every call blocks, so call it off the main thread.
 */
object BackupNative {
  init {
    System.loadLibrary("kybl_lib")
  }

  /** Opens the engine on the app's folders (where Tauri keeps them: data and config in `dataDir`). */
  @JvmStatic external fun init(ctx: Context, data: String, config: String, cache: String): Boolean

  /** One engine call: `{"ok": …}` or `{"error": "…"}` (the method table is in headless.rs). */
  @JvmStatic external fun call(method: String, args: String): String

  /** Items for a set (JSON array): what to upload, `[{sourceId, remotePath, …}]`. */
  @JvmStatic external fun offer(setId: String, items: String): String

  /** Uploads one item from `fd`, which Rust takes over and closes. Answers `{status, remotePath?, error?}`. */
  @JvmStatic external fun upload(setId: String, sourceId: String, remotePath: String, fd: Int, size: Long, mtime: Long): String

  /** Stops one set's run (null: every run): the upload in flight ends and answers "cancelled". */
  @JvmStatic external fun cancel(setId: String?)

  @Volatile private var ready = false

  /** Opens the engine once per process. False when it couldn't (the run is retried later). */
  @Synchronized
  fun ensure(ctx: Context): Boolean {
    if (ready) return true
    val app = ctx.applicationContext
    @Suppress("DEPRECATION")
    val data = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) app.dataDir.absolutePath else app.applicationInfo.dataDir
    ready = init(app, data, data, app.cacheDir.absolutePath)
    if (ready) {
      try {
        request("device", JSONObject().put("name", deviceName()))
      } catch (e: Exception) {
        // only the {device} token misses it
      }
    }
    return ready
  }

  private fun deviceName(): String {
    val model = Build.MODEL ?: ""
    val maker = Build.MANUFACTURER ?: ""
    return if (maker.isNotEmpty() && !model.startsWith(maker, ignoreCase = true)) "${maker.replaceFirstChar { it.uppercase() }} $model" else model
  }

  class BackupError(message: String) : Exception(message)

  /** A call whose answer is the `ok` value; an `error` answer throws [BackupError]. */
  fun request(method: String, args: JSONObject = JSONObject()): Any? {
    val o = JSONObject(call(method, args.toString()))
    if (o.has("error")) throw BackupError(o.optString("error"))
    return if (o.isNull("ok")) null else o.get("ok")
  }

  /** The backup sets, as the engine keeps them. */
  fun sets(): List<JSONObject> {
    val arr = request("sets") as? JSONArray ?: return emptyList()
    return (0 until arr.length()).map { arr.getJSONObject(it) }
  }
}
