package app.kybl.mobile

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.os.Build
import android.os.Environment
import androidx.core.content.ContextCompat
import java.io.File
import org.json.JSONObject

/**
 * Questions Rust asks over JNI on the application context (src/platform/android.rs), so they
 * work before the screen exists and after it is gone.
 */
object Platform {
  /**
   * Where downloads can go. The shared Download folder comes from Android rather than a fixed
   * `/storage/emulated/0` path, which is wrong in a work profile (user 10, …).
   */
  @JvmStatic
  @Suppress("DEPRECATION")
  fun storage(ctx: Context): String {
    val shared = try {
      Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)?.absolutePath
    } catch (e: Exception) {
      null
    }
    // the app's own folder in shared storage (Android/data/…): no permission needed, and file
    // managers show it; the private files folder only if shared storage isn't there at all
    val own = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: File(ctx.filesDir, "Downloads")
    val canWrite = Build.VERSION.SDK_INT >= 30 ||
      ContextCompat.checkSelfPermission(ctx, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    return JSONObject()
      .put("sdk", Build.VERSION.SDK_INT)
      .put("publicDownloads", shared ?: "")
      .put("appDownloads", own.absolutePath)
      .put("canWrite", canWrite)
      .toString()
  }

  /** Mobile data or a metered Wi-Fi (a phone's hotspot): for the "Wi-Fi only" setting. */
  @JvmStatic
  fun isMetered(ctx: Context): Boolean {
    val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return false
    return cm.isActiveNetworkMetered
  }
}
