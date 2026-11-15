package app.kybl.mobile

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class TransferSnapshot {
  var active: Int = 0
  var title: String = ""
  var text: String = ""
  var done: Long = 0
  var total: Long = 0
  var ok: Int = 0
  var failed: Int = 0
  var kind: String = "download"
}

/**
 * Called from Rust (src/transfer_notice.rs) while uploads or downloads run: `update` starts or
 * refreshes [TransferService], `stop` ends it. The first transfer asks for the notification
 * permission (Android 13+); without it the service still keeps transfers alive, just unseen.
 */
@TauriPlugin
class TransferPlugin(private val activity: Activity) : Plugin(activity) {
  private var askedPermission = false

  @Command
  fun update(invoke: Invoke) {
    val s = invoke.parseArgs(TransferSnapshot::class.java)
    askForNotifications()
    TransferService.update(activity.applicationContext, s)
    invoke.resolve()
  }

  @Command
  fun stop(invoke: Invoke) {
    val s = invoke.parseArgs(TransferSnapshot::class.java)
    TransferService.stop(activity.applicationContext, s)
    invoke.resolve()
  }

  private fun askForNotifications() {
    if (askedPermission || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    askedPermission = true
    if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      activity.runOnUiThread {
        ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7101)
      }
    }
  }
}
