package app.kybl.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import org.json.JSONObject

/**
 * Foreground service that runs while any upload or download is queued or running. Android
 * freezes a backgrounded app within seconds, cutting its connections; a foreground service (and
 * a partial wake lock, for the screen going off) keeps the Rust transfers going. Its
 * notification shows the combined progress. When the last transfer ends the service stops, and
 * if the app is not on screen a short summary notification says how it went.
 */
class TransferService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val n = latest?.let { progressNotification(this, it) } ?: progressNotification(this, TransferSnapshot())
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(PROGRESS_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(PROGRESS_ID, n)
      }
    } catch (e: Exception) {
      // not allowed right now (started from the background): transfers run as long as Android lets them
      stopSelf()
      return START_NOT_STICKY
    }
    if (wakeLock == null) {
      wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kybl:transfers")
        .apply { setReferenceCounted(false); acquire(3 * 60 * 60 * 1000L) }
    }
    running = true
    return START_NOT_STICKY
  }

  /** Android 15 caps data-sync services at 6 hours a day. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    stopSelf()
  }

  override fun onDestroy() {
    running = false
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
  }

  companion object {
    private const val CHANNEL = "transfers"
    private const val PROGRESS_ID = 7100
    private const val DONE_ID = 7102

    @Volatile private var running = false
    @Volatile private var latest: TransferSnapshot? = null

    /**
     * Called from Rust over JNI (src/transfer_notice.rs) with the combined state as JSON, on the
     * application context: unlike a Tauri plugin call it works after the app's screen has been
     * swiped away, which is when this service matters most. `active == 0` stops the service.
     */
    @JvmStatic
    fun fromRust(ctx: Context, json: String) {
      val o = JSONObject(json)
      val s = TransferSnapshot().apply {
        active = o.optInt("active")
        title = o.optString("title")
        text = o.optString("text")
        done = o.optLong("done")
        total = o.optLong("total")
        ok = o.optInt("ok")
        failed = o.optInt("failed")
        kind = o.optString("kind", "download")
      }
      val app = ctx.applicationContext
      Handler(Looper.getMainLooper()).post {
        if (s.active == 0) stop(app, s) else update(app, s)
      }
    }

    fun update(ctx: Context, s: TransferSnapshot) {
      latest = s
      channel(ctx)
      if (running) {
        notify(ctx, PROGRESS_ID, progressNotification(ctx, s))
      } else {
        try {
          ContextCompat.startForegroundService(ctx, Intent(ctx, TransferService::class.java))
        } catch (e: Exception) {
          // Android 12+ refuses to start one from the background; nothing more to do
        }
      }
    }

    fun stop(ctx: Context, s: TransferSnapshot) {
      latest = null
      running = false
      ctx.stopService(Intent(ctx, TransferService::class.java))
      NotificationManagerCompat.from(ctx).cancel(PROGRESS_ID)
      val onScreen = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
      if (!onScreen && s.ok + s.failed > 0) {
        channel(ctx)
        notify(ctx, DONE_ID, doneNotification(ctx, s))
      }
    }

    private fun notify(ctx: Context, id: Int, n: Notification) {
      try {
        NotificationManagerCompat.from(ctx).notify(id, n)
      } catch (e: SecurityException) {
        // notifications are turned off for the app
      }
    }

    private fun channel(ctx: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val nm = ctx.getSystemService(NotificationManager::class.java)
      if (nm.getNotificationChannel(CHANNEL) == null) {
        nm.createNotificationChannel(
          NotificationChannel(CHANNEL, "Uploads and downloads", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Progress of files going to and from your storage"
            setShowBadge(false)
          }
        )
      }
    }

    private fun openApp(ctx: Context): PendingIntent? {
      val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return null
      launch.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
      return PendingIntent.getActivity(ctx, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun progressNotification(ctx: Context, s: TransferSnapshot): Notification {
      val upload = s.kind == "upload"
      val b = NotificationCompat.Builder(ctx, CHANNEL)
        .setSmallIcon(if (upload) android.R.drawable.stat_sys_upload else android.R.drawable.stat_sys_download)
        .setContentTitle(s.title.ifEmpty { "Kybl" })
        .setContentText(s.text.ifEmpty { "Starting…" })
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setCategory(NotificationCompat.CATEGORY_PROGRESS)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .setContentIntent(openApp(ctx))
      if (s.total > 0) {
        val pct = ((s.done.toDouble() / s.total) * 1000).toInt().coerceIn(0, 1000)
        b.setProgress(1000, pct, false)
      } else {
        b.setProgress(0, 0, true)
      }
      return b.build()
    }

    private fun doneNotification(ctx: Context, s: TransferSnapshot): Notification {
      val noun = when (s.kind) {
        "upload" -> "upload"
        "both" -> "transfer"
        else -> "download"
      }
      fun files(n: Int) = if (n == 1) "1 file" else "$n files"
      val (title, text) = when {
        s.failed == 0 -> when (s.kind) {
          "upload" -> "Uploaded ${files(s.ok)}"
          "both" -> "Transferred ${files(s.ok)}"
          else -> "Downloaded ${files(s.ok)}"
        } to if (s.kind == "upload") "Your storage is up to date." else "Saved to Download/Kybl."
        s.ok == 0 -> (if (s.failed == 1) "A $noun failed" else "${s.failed} ${noun}s failed") to "Open Kybl to see what went wrong."
        else -> "${files(s.ok)} done, ${s.failed} failed" to "Open Kybl to see what went wrong."
      }
      return NotificationCompat.Builder(ctx, CHANNEL)
        .setSmallIcon(if (s.failed == 0) android.R.drawable.stat_sys_download_done else android.R.drawable.stat_notify_error)
        .setContentTitle(title)
        .setContentText(text)
        .setAutoCancel(true)
        .setContentIntent(openApp(ctx))
        .build()
    }
  }
}
