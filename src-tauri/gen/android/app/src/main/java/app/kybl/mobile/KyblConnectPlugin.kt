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
  /** the scheme that ends the sign-in; "kybl" when not given (see the intent filters) */
  var callbackScheme: String? = null
  /** the one address under that scheme that ends this sign-in (see [SignInCallback]) */
  var callbackUrl: String? = null
}

/**
 * Browser sign-in on Android: "Connect Kybl Storage" (src/kybl_connect.rs) and the cloud drives
 * (src/oauth/mod.rs). `signIn` opens the page in a Custom Tab and resolves with the redirect to
 * `callbackScheme` (`kybl://connect?code=…&state=…`, `kybl://oauth/onedrive?code=…`, or
 * `kybl://oauth/done` after a sign-in that came back to Kybl's loopback address); MainActivity is
 * singleTask, so that redirect closes the tab and lands here in onNewIntent. Closing the tab
 * without approving resolves with `{cancelled: true}`.
 */
@TauriPlugin
class KyblConnectPlugin(private val activity: Activity) : Plugin(activity) {
  private val main = Handler(Looper.getMainLooper())
  private var pending: Invoke? = null
  private var pendingScheme = "kybl"
  /** the address that ends the pending sign-in; null: any link with [pendingScheme] */
  private var pendingCallback: String? = SignInCallback.CONNECT
  /** the tab took over the screen since signIn: coming back without a redirect means it was closed */
  private var away = false

  @Command
  fun signIn(invoke: Invoke) {
    val args = invoke.parseArgs(SignInArgs::class.java)
    main.post {
      pending?.resolve(JSObject().put("cancelled", true))
      pending = invoke
      pendingScheme = args.callbackScheme?.takeIf { it.isNotBlank() } ?: "kybl"
      pendingCallback = SignInCallback.expected(pendingScheme, args.callbackUrl)
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
      // the tab is still open (the sign-in ended elsewhere, or timed out): bring Kybl back, which
      // closes the tab above it in this singleTask activity's task
      if (away) {
        away = false
        try {
          activity.startActivity(
            Intent(activity, activity.javaClass).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
          )
        } catch (e: Exception) {
          // nothing to bring back
        }
      }
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
    // another kybl:// link (a web page, another app) leaves the sign-in waiting
    if (!SignInCallback.matches(data.toString(), pendingScheme, pendingCallback)) return
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
