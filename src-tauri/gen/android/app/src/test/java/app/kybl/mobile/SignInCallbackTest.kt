package app.kybl.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SignInCallbackTest {
  private fun ends(url: String, scheme: String = "kybl", callbackUrl: String? = null) =
    SignInCallback.matches(url, scheme, SignInCallback.expected(scheme, callbackUrl))

  @Test
  fun connectOnlyEndsAtKyblConnect() {
    assertTrue(ends("kybl://connect?code=abc&state=s1"))
    assertTrue(ends("kybl://connect"))
    assertFalse(ends("kybl://oauth/done"))
    assertFalse(ends("kybl://open?file=x"))
    assertFalse(ends("kybl://connector?code=abc"))
  }

  @Test
  fun cloudSignInsEndAtTheirOwnAddress() {
    assertTrue(ends("kybl://oauth/onedrive?code=c&state=s", callbackUrl = "kybl://oauth/onedrive"))
    assertFalse(ends("kybl://oauth/dropbox?code=c&state=s", callbackUrl = "kybl://oauth/onedrive"))
    assertFalse(ends("kybl://connect?code=c&state=s", callbackUrl = "kybl://oauth/onedrive"))
    assertFalse(ends("kybl://oauth/onedrive/../done", callbackUrl = "kybl://oauth/onedrive"))
    assertTrue(ends("kybl://oauth/done", callbackUrl = "kybl://oauth/done"))
    assertTrue(ends("KYBL://oauth/done#x", callbackUrl = "kybl://oauth/done"))
    assertFalse(ends("kybl://oauth/onedrive", callbackUrl = "kybl://oauth/done"))
    assertFalse(ends("https://oauth/done", callbackUrl = "kybl://oauth/done"))
  }

  @Test
  fun aProvidersOwnSchemeTakesAnyLinkWithIt() {
    val scheme = "com.googleusercontent.apps.123"
    assertNull(SignInCallback.expected(scheme, null))
    assertTrue(ends("$scheme:/oauth2redirect?code=c", scheme))
    assertFalse(ends("kybl://connect?code=c", scheme))
    assertEquals(SignInCallback.CONNECT, SignInCallback.expected("kybl", " "))
  }
}
