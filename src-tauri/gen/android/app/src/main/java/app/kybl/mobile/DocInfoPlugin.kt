package app.kybl.mobile

import android.app.Activity
import android.net.Uri
import android.provider.OpenableColumns
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class QueryArgs {
  lateinit var uri: String
}

/** Display name and size of a document the system picker handed over (see src/mobile.rs). */
@TauriPlugin
class DocInfoPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun query(invoke: Invoke) {
    val args = invoke.parseArgs(QueryArgs::class.java)
    val ret = JSObject()
    try {
      val uri = Uri.parse(args.uri)
      activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          val s = c.getColumnIndex(OpenableColumns.SIZE)
          if (n >= 0 && !c.isNull(n)) ret.put("name", c.getString(n))
          if (s >= 0 && !c.isNull(s)) ret.put("size", c.getLong(s))
        }
      }
      invoke.resolve(ret)
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Could not read the picked file")
    }
  }
}
