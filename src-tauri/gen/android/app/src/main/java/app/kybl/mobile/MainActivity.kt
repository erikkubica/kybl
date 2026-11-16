package app.kybl.mobile

import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  /**
   * The system back goes to the page's own back stack (window.__kyblBack), not the WebView history:
   * Chrome skips history entries added without a tap, so history-based back would leave the app
   * early. When the page has nothing left to close, back does what Android normally does.
   */
  override val handleBackNavigation: Boolean = false

  /** Latest system-bar insets in CSS px, as the JSON the page reads at start-up. */
  @Volatile private var insetsJson = "{\"top\":0,\"bottom\":0,\"left\":0,\"right\":0}"

  override fun onCreate(savedInstanceState: Bundle?) {
    // counted before Tauri hears of it: see [screens]
    screens++
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onDestroy() {
    super.onDestroy()
    screens--
  }

  companion object {
    @Volatile private var screens = 0

    /**
     * How many Kybl screens exist. Read from Rust over JNI (src/transfer_notice.rs): after the
     * app was swiped away while transfers ran, the process lives on without a window, and
     * opening Kybl again makes a new screen that needs one.
     */
    @JvmStatic fun screens(): Int = screens
  }

  /**
   * Edge-to-edge is forced on Android 15+, but Android's WebView reports 0 for
   * env(safe-area-inset-*). Hand the real insets to the page as CSS variables
   * (--a-top, ...) and shrink the WebView above the keyboard, which adjustResize
   * no longer does in edge-to-edge mode.
   */
  override fun onWebViewCreate(webView: WebView) {
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript("!!(window.__kyblBack && window.__kyblBack())") { handled ->
          if (handled != "true") {
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            isEnabled = true
          }
        }
      }
    })

    // the window background (themes.xml) shows through until the page paints: no white flash
    webView.setBackgroundColor(Color.TRANSPARENT)

    webView.addJavascriptInterface(object {
      @JavascriptInterface fun insets(): String = insetsJson

      /** Status / navigation bar icons to match the page's theme; null follows the system. */
      @JavascriptInterface fun setDark(dark: String?) {
        runOnUiThread {
          val systemDark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
          val isDark = when (dark) {
            "true" -> true
            "false" -> false
            else -> systemDark
          }
          WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !isDark
            isAppearanceLightNavigationBars = !isDark
          }
          window.decorView.setBackgroundColor(if (isDark) Color.rgb(0x1d, 0x1a, 0x1a) else Color.rgb(0xf8, 0xf6, 0xf5))
        }
      }
    }, "KyblInsets")

    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val d = view.resources.displayMetrics.density
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      val keyboard = ime.bottom > bars.bottom
      val bottom = if (keyboard) 0 else bars.bottom
      insetsJson = "{\"top\":${bars.top / d},\"bottom\":${bottom / d},\"left\":${bars.left / d},\"right\":${bars.right / d}}"

      (view.layoutParams as? ViewGroup.MarginLayoutParams)?.let { lp ->
        val margin = if (keyboard) ime.bottom else 0
        if (lp.bottomMargin != margin) {
          lp.bottomMargin = margin
          view.layoutParams = lp
        }
      }
      (view as WebView).evaluateJavascript("window.__kyblInsets && window.__kyblInsets($insetsJson)", null)
      insets
    }
  }
}
