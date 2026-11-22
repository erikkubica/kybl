package app.kybl.mobile

/**
 * Rust functions Kotlin calls, exported from src/platform/android.rs. They work with or without
 * the app's screen (the process can outlive it while transfers run).
 */
object KyblNative {
  init {
    // already loaded by the activity; loading it again is a no-op
    System.loadLibrary("kybl_lib")
  }

  /** Files shared into Kybl, copied into the cache: JSON `[{path, name, size}]`. */
  @JvmStatic external fun sharedFiles(json: String)

  /** "Cancel" on the transfer notification: stops every running and queued transfer. */
  @JvmStatic external fun cancelAllTransfers()

  /** A transfer notification was tapped: the page shows Transfers. */
  @JvmStatic external fun openTransfers()
}
