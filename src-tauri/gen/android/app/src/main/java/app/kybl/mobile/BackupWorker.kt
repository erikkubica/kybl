package app.kybl.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.BatteryManager
import android.os.Build
import android.provider.MediaStore
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Runs backups: every 15 minutes per set (with the set's "Wi-Fi only" and "only while charging"
 * as WorkManager constraints), soon after new photos appear (a content-URI trigger), when the
 * app opens, and on "Back up now". One code path for all of them; the Rust engine decides what
 * goes up and where (src/backup).
 *
 * While uploading it runs as a data-sync foreground service with a progress notification, where
 * Android allows starting one. Stopped by Android (constraints no longer met, the Android 15
 * six-hour data-sync limit, the app being force-stopped), it cancels the upload in flight and
 * ends the run cleanly; the next run carries on with what is left.
 */
class BackupWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
  private var foreground = false
  /** The set this worker is running right now (other workers may be running other sets). */
  @Volatile private var current: String? = null

  override suspend fun getForegroundInfo(): ForegroundInfo = BackupScheduler.foregroundInfo(applicationContext, "Backing up", 0, 0)

  override suspend fun doWork(): Result = coroutineScope {
    // a stop cancels this scope: the watcher's `finally` ends the blocking upload in Rust, of
    // this worker's set only (a stopped media-trigger run must not end a "Back up now")
    val watcher = launch {
      try {
        awaitCancellation()
      } finally {
        if (isStopped) current?.let { BackupNative.cancel(it) }
      }
    }
    val result = withContext(Dispatchers.IO) { runAll() }
    watcher.cancel()
    result
  }

  private suspend fun runAll(): Result {
    val ctx = applicationContext
    if (!BackupNative.ensure(ctx)) return Result.retry()
    val manual = inputData.getBoolean(KEY_MANUAL, false)
    val only = inputData.getString(KEY_SET)
    var retry = false
    try {
      for (set in BackupNative.sets()) {
        if (isStopped) break
        if (!set.optBoolean("enabled", true)) continue
        if (only != null && set.optString("id") != only) continue
        // "Back up now" goes ahead on battery; automatic runs respect the setting
        if (!manual && set.optBoolean("chargingOnly") && !BackupScheduler.charging(ctx)) continue
        current = set.optString("id")
        try {
          if (runSet(set)) retry = true
        } finally {
          current = null
        }
      }
    } catch (e: Exception) {
      retry = true
    } finally {
      if (inputData.getBoolean(KEY_TRIGGER, false) && only != null) BackupScheduler.watchMedia(ctx, only)
    }
    return if (retry && !isStopped) Result.retry() else Result.success()
  }

  /** One set's run. True when it stopped for the network and should be tried again soon. */
  private suspend fun runSet(set: JSONObject): Boolean {
    val ctx = applicationContext
    val id = set.getString("id")
    val start = BackupNative.request("runStart", JSONObject().put("setId", id)) as? JSONObject
    if (start?.optBoolean("run") != true) return false
    var error: String? = null
    var retry = false
    try {
      val source = set.getJSONObject("source")
      when (source.optString("type")) {
        "cameraRoll" -> {
          if (!BackupSources.canReadMedia(ctx)) {
            error = "Kybl isn't allowed to see your photos. Open the backup screen to allow it."
            return false
          }
          BackupSources.scanMedia(ctx, set)
        }
        "androidTree" -> BackupSources.scanTree(ctx, set)
        else -> return false
      }
      val pending = BackupNative.request("pending", JSONObject().put("setId", id)) as? JSONArray ?: JSONArray()
      for (i in 0 until pending.length()) {
        if (isStopped) break
        val p = pending.getJSONObject(i)
        val sourceId = p.getString("sourceId")
        if (!foreground) startForeground(p.optString("name"), i, pending.length())
        else if (i % 5 == 0) notifyProgress(p.optString("name"), i, pending.length())
        when (val opened = BackupSources.open(ctx, set, sourceId, p.optString("kind"))) {
          is BackupSources.Opened.Gone -> BackupNative.request("gone", JSONObject().put("setId", id).put("sourceId", sourceId))
          is BackupSources.Opened.Failed -> BackupNative.request("fail", JSONObject().put("setId", id).put("sourceId", sourceId).put("error", opened.error))
          is BackupSources.Opened.Fd -> {
            val r = JSONObject(BackupNative.upload(id, sourceId, p.optString("remotePath"), opened.fd, opened.size, 0))
            when (r.optString("status")) {
              "cancelled", "waitingWifi" -> return false
              "retryLater" -> {
                retry = true
                return true
              }
              "needsAuth" -> return false
            }
          }
        }
      }
    } catch (e: SecurityException) {
      error = "Kybl can't open this folder any more. Remove this backup and pick the folder again."
    } catch (e: Exception) {
      error = e.message
      retry = true
    } finally {
      try {
        BackupNative.request("runEnd", JSONObject().put("setId", id).apply { if (error != null) put("error", error) })
      } catch (e: Exception) {
      }
    }
    return retry
  }

  private suspend fun startForeground(name: String, done: Int, total: Int) {
    foreground = true
    try {
      setForeground(BackupScheduler.foregroundInfo(applicationContext, name, done, total))
    } catch (e: Exception) {
      // Android 12+ may refuse a foreground service started from the background: the run goes
      // on for as long as WorkManager gives it, and the next run carries on
    }
  }

  private fun notifyProgress(name: String, done: Int, total: Int) {
    try {
      val nm = applicationContext.getSystemService(NotificationManager::class.java)
      nm.notify(BackupScheduler.NOTIFICATION_ID, BackupScheduler.notification(applicationContext, name, done, total))
    } catch (e: Exception) {
    }
  }

  companion object {
    const val KEY_SET = "setId"
    const val KEY_MANUAL = "manual"
    const val KEY_TRIGGER = "trigger"
  }
}

/** Keeps WorkManager's schedule in step with the backup sets. */
object BackupScheduler {
  const val NOTIFICATION_ID = 7200
  private const val CHANNEL = "backup"
  private const val TAG = "kybl-backup"

  private fun periodicName(id: String) = "backup-periodic-$id"
  private fun mediaName(id: String) = "backup-media-$id"

  private fun constraints(set: JSONObject?): Constraints.Builder = Constraints.Builder()
    .setRequiredNetworkType(if (set?.optBoolean("wifiOnly", true) == true) NetworkType.UNMETERED else NetworkType.CONNECTED)
    .setRequiresCharging(set?.optBoolean("chargingOnly") == true)

  /** Schedules each enabled set and cancels the rest (and those removed since last time). */
  fun schedule(ctx: Context) {
    if (!BackupNative.ensure(ctx)) return
    val wm = WorkManager.getInstance(ctx)
    val prefs = ctx.getSharedPreferences("backup", Context.MODE_PRIVATE)
    val sets = BackupNative.sets()
    val ids = sets.map { it.getString("id") }.toSet()
    for (old in prefs.getStringSet("scheduled", emptySet()).orEmpty() - ids) {
      wm.cancelUniqueWork(periodicName(old))
      wm.cancelUniqueWork(mediaName(old))
      BackupSources.forget(ctx, old)
    }
    for (set in sets) {
      val id = set.getString("id")
      if (!set.optBoolean("enabled", true)) {
        wm.cancelUniqueWork(periodicName(id))
        wm.cancelUniqueWork(mediaName(id))
        continue
      }
      val periodic = PeriodicWorkRequestBuilder<BackupWorker>(15, TimeUnit.MINUTES)
        .setConstraints(constraints(set).build())
        .setInputData(Data.Builder().putString(BackupWorker.KEY_SET, id).build())
        .addTag(TAG)
        .build()
      // UPDATE keeps the schedule's timing and only changes its constraints
      wm.enqueueUniquePeriodicWork(periodicName(id), ExistingPeriodicWorkPolicy.UPDATE, periodic)
      // KEEP: this runs on every app open, and replacing would cancel a media run under way
      // (a waiting trigger picks up new constraints the next time it puts itself back)
      if (set.optJSONObject("source")?.optString("type") == "cameraRoll") watchMedia(ctx, id, set, ExistingWorkPolicy.KEEP)
      else wm.cancelUniqueWork(mediaName(id))
    }
    prefs.edit().putStringSet("scheduled", ids).apply()
  }

  /**
   * A run soon after a new photo or video appears. A content trigger fires once, so the worker
   * puts it back after each run (appended behind itself, which is still running then).
   */
  fun watchMedia(ctx: Context, id: String, set: JSONObject? = null, policy: ExistingWorkPolicy = ExistingWorkPolicy.APPEND_OR_REPLACE) {
    val s = set ?: BackupNative.sets().firstOrNull { it.optString("id") == id } ?: return
    if (!s.optBoolean("enabled", true)) return
    val c = constraints(s)
      .addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
      .addContentUriTrigger(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true)
      .setTriggerContentUpdateDelay(30, TimeUnit.SECONDS)
      .setTriggerContentMaxDelay(5, TimeUnit.MINUTES)
      .build()
    val req = OneTimeWorkRequestBuilder<BackupWorker>()
      .setConstraints(c)
      .setInputData(Data.Builder().putString(BackupWorker.KEY_SET, id).putBoolean(BackupWorker.KEY_TRIGGER, true).build())
      .addTag(TAG)
      .build()
    WorkManager.getInstance(ctx).enqueueUniqueWork(mediaName(id), policy, req)
  }

  /**
   * A run right away: "Back up now" (`manual`, expedited where the quota allows, ignores "only
   * while charging") or the app opening. Each set and kind has its own queue: "Back up now"
   * waits behind a run of the same kind already going on (never dropped), an app-open run
   * already queued is enough.
   */
  fun runNow(ctx: Context, setId: String?, manual: Boolean) {
    val data = Data.Builder().putBoolean(BackupWorker.KEY_MANUAL, manual)
    if (setId != null) data.putString(BackupWorker.KEY_SET, setId)
    val b = OneTimeWorkRequestBuilder<BackupWorker>()
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
      .setInputData(data.build())
      .addTag(TAG)
    if (manual) b.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
    val name = "backup-now-${setId ?: "all"}-${if (manual) "manual" else "open"}"
    val policy = if (manual) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.KEEP
    WorkManager.getInstance(ctx).enqueueUniqueWork(name, policy, b.build())
  }

  fun charging(ctx: Context): Boolean {
    val status = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
    return status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
  }

  private fun channel(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = ctx.getSystemService(NotificationManager::class.java)
    if (nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL, "Photo backup", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Progress while photos and folders are backed up"
          setShowBadge(false)
        }
      )
    }
  }

  fun notification(ctx: Context, name: String, done: Int, total: Int): Notification {
    channel(ctx)
    val open = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val tap = PendingIntent.getActivity(ctx, 1, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    return NotificationCompat.Builder(ctx, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle(if (total > 0) "Backing up ${done + 1} of $total" else "Backing up")
      .setContentText(name)
      .setProgress(total, done, total == 0)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setContentIntent(tap)
      .build()
  }

  fun foregroundInfo(ctx: Context, name: String, done: Int, total: Int): ForegroundInfo {
    val n = notification(ctx, name, done, total)
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ForegroundInfo(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    else ForegroundInfo(NOTIFICATION_ID, n)
  }
}
