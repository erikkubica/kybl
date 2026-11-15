package app.kybl.mobile

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class SignInArgs {
  lateinit var url: String
}

/**
 * "Connect Kybl Storage" on Android (see src/kybl_connect.rs). `signIn` opens the account site in a
 * Custom Tab and resolves with the `kybl://connect?code=…&state=…` redirect the page sends back;
 * MainActivity is singleTask, so that redirect closes the tab and lands here in onNewIntent.
 * Closing the tab without approving resolves with `{cancelled: true}`.
 */
@TauriPlugin
class KyblConnectPlugin(private val activity: Activity) : Plugin(activity) {
  private val main = Handler(Looper.getMainLooper())
  private var pending: Invoke? = null
  /** the tab took over the screen since signIn: coming back without a redirect means it was closed */
  private var away = false

  @Command
  fun signIn(invoke: Invoke) {
    val args = invoke.parseArgs(SignInArgs::class.java)
    main.post {
      pending?.resolve(JSObject().put("cancelled", true))
      pending = invoke
      away = false
      val uri = Uri.parse(args.url)
      try {
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, uri)
      } catch (e: ActivityNotFoundException) {
        // no browser that supports Custom Tabs: any browser will do
        try {
          activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (e: ActivityNotFoundException) {
          pending = null
          invoke.reject("No web browser is installed. Use a code instead.")
        }
      }
    }
  }

  @Command
  fun cancel(invoke: Invoke) {
    main.post {
      pending?.resolve(JSObject().put("cancelled", true))
      pending = null
      invoke.resolve()
    }
  }

  /** What the user calls this phone ("Sam's Pixel"), else the model ("Pixel 9"). */
  @Command
  fun deviceName(invoke: Invoke) {
    val set = try {
      Settings.Global.getString(activity.contentResolver, Settings.Global.DEVICE_NAME)
    } catch (e: Exception) {
      null
    }
    val model = Build.MODEL ?: ""
    val maker = Build.MANUFACTURER ?: ""
    val fallback = if (model.startsWith(maker, ignoreCase = true) || maker.isEmpty()) model else "$maker $model"
    invoke.resolve(JSObject().put("name", set?.takeIf { it.isNotBlank() } ?: fallback))
  }

  override fun onNewIntent(intent: Intent) {
    val data = intent.data ?: return
    if (data.scheme != "kybl") return
    val inv = pending ?: return
    pending = null
    inv.resolve(JSObject().put("url", data.toString()))
  }

  override fun onPause(activity: AppCompatActivity) {
    if (pending != null) away = true
  }

  override fun onResume(activity: AppCompatActivity) {
    val waiting = pending ?: return
    if (!away) return
    away = false
    // onNewIntent comes before onResume when the redirect brings the app back; give it a moment
    main.postDelayed({
      if (pending === waiting && !away) {
        pending = null
        waiting.resolve(JSObject().put("cancelled", true))
      }
    }, 700)
  }
}
