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
  /** where downloads went, as a file manager shows it ("Download/Kybl") */
  var savedTo: String = ""
}

/**
 * The first transfer asks for the notification permission (Android 13+); without it
 * [TransferService] still keeps transfers alive, just unseen. The service itself is driven from
 * Rust over JNI ([TransferService.fromRust]), which keeps working once the app's screen is gone.
 */
@TauriPlugin
class TransferPlugin(private val activity: Activity) : Plugin(activity) {
  private var askedPermission = false

  @Command
  fun askNotifications(invoke: Invoke) {
    askForNotifications()
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
