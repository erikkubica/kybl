package app.kybl.mobile

/**
 * Which link ends a browser sign-in. While one waits, any app or web page can open a `kybl://`
 * link, so only the address the sign-in itself comes back to may end it:
 * `kybl://connect` (Connect Kybl Storage), `kybl://oauth/onedrive` (Microsoft) or
 * `kybl://oauth/done` (the loopback sign-ins). Anything else leaves the sign-in waiting.
 * Plain strings, no android.net.Uri, so it runs in a JVM unit test.
 */
object SignInCallback {
  /** What Connect Kybl Storage comes back to; it doesn't say (src/kybl_connect.rs). */
  const val CONNECT = "kybl://connect"

  /**
   * The address that ends a sign-in started with `scheme` and `callbackUrl` (both from Rust).
   * Null: any link with the scheme does (a provider's own scheme, such as Google's on iOS).
   */
  fun expected(scheme: String, callbackUrl: String?): String? {
    val given = callbackUrl?.trim()?.takeIf { it.isNotEmpty() }
    return when {
      given != null -> given
      scheme.equals("kybl", ignoreCase = true) -> CONNECT
      else -> null
    }
  }

  /** True when `url` is the address `expected` (with its query or fragment), and nothing else. */
  fun matches(url: String, scheme: String, expected: String?): Boolean {
    val colon = url.indexOf(':')
    if (colon <= 0 || !url.substring(0, colon).equals(scheme, ignoreCase = true)) return false
    if (expected == null) return true
    val end = url.indexOfAny(charArrayOf('?', '#')).let { if (it < 0) url.length else it }
    val address = url.substring(0, end).trimEnd('/')
    return address.equals(expected.trimEnd('/'), ignoreCase = true)
  }
}
