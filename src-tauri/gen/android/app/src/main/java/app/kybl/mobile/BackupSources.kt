package app.kybl.mobile

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.FileNotFoundException
import java.util.TimeZone

/**
 * What a backup set reads on Android: the camera roll through MediaStore, or a folder picked
 * with the system picker through DocumentsContract (DocumentFile is far too slow for big
 * folders). Both hand items to the Rust engine in batches and open the ones it asks for as file
 * descriptors, so big videos are streamed, never copied into the cache.
 */
object BackupSources {
  private const val BATCH = 300
  private const val WEEK = 7L * 24 * 3600 * 1000

  private fun prefs(ctx: Context) = ctx.getSharedPreferences("backup", Context.MODE_PRIVATE)

  /** Forgets where a set's scan stopped (it was removed or recreated): the next scan is a full one. */
  fun forget(ctx: Context, setId: String) {
    val p = prefs(ctx)
    p.edit().apply { p.all.keys.filter { it.endsWith("|$setId") || it.contains("|$setId|") }.forEach { remove(it) } }.apply()
  }

  private fun item(sourceId: String, kind: String, name: String, size: Long, created: Long, modified: Long, mime: String?, album: String?, relPath: String?) =
    JSONObject().apply {
      put("sourceId", sourceId)
      put("kind", kind)
      put("name", name)
      put("size", size)
      if (created > 0) put("created", created)
      if (modified > 0) put("modified", modified)
      if (mime != null) put("mime", mime)
      if (album != null) put("album", album)
      if (relPath != null) put("relPath", relPath)
      val at = if (created > 0) created else System.currentTimeMillis()
      put("tzOffset", TimeZone.getDefault().getOffset(at) / 60000)
    }

  /** Hands `items` to the engine once there are enough of them (or `flush`). */
  private class Batcher(val setId: String) {
    val items = JSONArray()
    fun add(o: JSONObject) {
      items.put(o)
      if (items.length() >= BATCH) flush()
    }
    fun flush() {
      if (items.length() == 0) return
      val answer = BackupNative.offer(setId, items.toString())
      if (answer.startsWith("{")) throw BackupNative.BackupError(JSONObject(answer).optString("error"))
      while (items.length() > 0) items.remove(items.length() - 1)
    }
  }

  // ------------------------------------------------------------ the camera roll

  private fun granted(ctx: Context, p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

  fun canReadMedia(ctx: Context): Boolean = when {
    Build.VERSION.SDK_INT >= 34 ->
      granted(ctx, Manifest.permission.READ_MEDIA_IMAGES) || granted(ctx, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
    Build.VERSION.SDK_INT >= 33 -> granted(ctx, Manifest.permission.READ_MEDIA_IMAGES)
    else -> granted(ctx, Manifest.permission.READ_EXTERNAL_STORAGE)
  }

  private fun volumes(ctx: Context): List<String> =
    if (Build.VERSION.SDK_INT >= 29) MediaStore.getExternalVolumeNames(ctx).toList() else listOf("external")

  private fun collection(volume: String, video: Boolean): Uri =
    if (video) MediaStore.Video.Media.getContentUri(volume) else MediaStore.Images.Media.getContentUri(volume)

  /**
   * Offers the photos (and videos) added or changed since the last scan: by MediaStore
   * generation on Android 11+, by date before. Once a week, and whenever MediaStore says its
   * numbering changed, everything is offered again (the engine skips what it has).
   */
  fun scanMedia(ctx: Context, set: JSONObject) {
    val setId = set.getString("id")
    val videos = set.optBoolean("includeVideos", true)
    val p = prefs(ctx)
    val now = System.currentTimeMillis()
    val full = now - p.getLong("full|$setId", 0) > WEEK
    val batch = Batcher(setId)
    val cursors = mutableMapOf<String, Long>()
    val versions = mutableMapOf<String, String>()
    for (volume in volumes(ctx)) {
      val genKey = "gen|$setId|$volume"
      val verKey = "ver|$setId|$volume"
      var since = if (full) -1L else p.getLong(genKey, -1)
      var next: Long
      val byGeneration = Build.VERSION.SDK_INT >= 30
      if (byGeneration) {
        // a new MediaStore version numbers generations afresh: scan everything
        val version = MediaStore.getVersion(ctx, volume)
        if (p.getString(verKey, null) != version) since = -1
        versions[verKey] = version
        // read before scanning: what changes during the scan is caught next time
        next = MediaStore.getGeneration(ctx, volume)
      } else {
        next = since
      }
      for (video in listOf(false, true)) {
        if (video && !videos) continue
        val max = query(ctx, volume, video, since, byGeneration) { batch.add(it) }
        if (!byGeneration) next = maxOf(next, max)
      }
      cursors[genKey] = next
    }
    batch.flush()
    // only now that everything was offered: a scan that failed halfway is done again
    p.edit().apply {
      cursors.forEach { (k, v) -> putLong(k, v) }
      versions.forEach { (k, v) -> putString(k, v) }
      if (full) putLong("full|$setId", now)
    }.apply()
  }

  /** Offers one collection's items newer than `since`; answers the highest date seen (seconds). */
  private fun query(ctx: Context, volume: String, video: Boolean, since: Long, byGeneration: Boolean, add: (JSONObject) -> Unit): Long {
    val cols = mutableListOf(
      MediaStore.MediaColumns._ID,
      MediaStore.MediaColumns.DISPLAY_NAME,
      MediaStore.MediaColumns.SIZE,
      MediaStore.MediaColumns.DATE_MODIFIED,
      MediaStore.MediaColumns.DATE_ADDED,
      MediaStore.MediaColumns.MIME_TYPE,
      if (video) MediaStore.Video.VideoColumns.DATE_TAKEN else MediaStore.Images.ImageColumns.DATE_TAKEN,
      if (video) MediaStore.Video.VideoColumns.BUCKET_DISPLAY_NAME else MediaStore.Images.ImageColumns.BUCKET_DISPLAY_NAME,
    )
    val (sel, args) = when {
      since < 0 -> null to null
      byGeneration -> "${MediaStore.MediaColumns.GENERATION_MODIFIED} > ?" to arrayOf(since.toString())
      else -> "${MediaStore.MediaColumns.DATE_MODIFIED} > ? OR ${MediaStore.MediaColumns.DATE_ADDED} > ?" to arrayOf(since.toString(), since.toString())
    }
    var max = since
    ctx.contentResolver.query(collection(volume, video), cols.toTypedArray(), sel, args, "${MediaStore.MediaColumns._ID} ASC")?.use { c ->
      val id = c.getColumnIndexOrThrow(cols[0])
      val name = c.getColumnIndexOrThrow(cols[1])
      val size = c.getColumnIndexOrThrow(cols[2])
      val mod = c.getColumnIndexOrThrow(cols[3])
      val added = c.getColumnIndexOrThrow(cols[4])
      val mime = c.getColumnIndexOrThrow(cols[5])
      val taken = c.getColumnIndexOrThrow(cols[6])
      val bucket = c.getColumnIndexOrThrow(cols[7])
      while (c.moveToNext()) {
        val modS = c.getLongOr(mod)
        val addedS = c.getLongOr(added)
        max = maxOf(max, modS, addedS)
        val takenMs = c.getLongOr(taken)
        val created = if (takenMs > 0) takenMs else addedS * 1000
        val n = c.getString(name) ?: "${c.getLong(id)}"
        add(item("$volume:${c.getLong(id)}", if (video) "video" else "photo", n, c.getLongOr(size), created, modS * 1000, c.getString(mime), c.getString(bucket), null))
      }
    }
    return max
  }

  private fun Cursor.getLongOr(i: Int): Long = if (isNull(i)) 0 else getLong(i)

  // ------------------------------------------------------------ picked folders

  /** Offers every file in a picked folder, however deep (the engine skips what it has). */
  fun scanTree(ctx: Context, set: JSONObject) {
    val setId = set.getString("id")
    val tree = Uri.parse(set.getJSONObject("source").getString("uri"))
    val batch = Batcher(setId)
    val todo = ArrayDeque<Pair<String, String>>()
    todo.add(DocumentsContract.getTreeDocumentId(tree) to "")
    val cols = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_SIZE,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED,
    )
    while (todo.isNotEmpty()) {
      val (parent, path) = todo.removeFirst()
      val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
      ctx.contentResolver.query(children, cols, null, null, null)?.use { c ->
        while (c.moveToNext()) {
          val doc = c.getString(0) ?: continue
          val name = c.getString(1) ?: continue
          // .nomedia, .thumbnails, ".trashed-…" files: not what people mean to back up
          if (name.startsWith(".")) continue
          val rel = if (path.isEmpty()) name else "$path/$name"
          if (c.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) {
            todo.add(doc to rel)
          } else {
            val modified = c.getLongOr(4)
            batch.add(item(doc, "file", name, c.getLongOr(3), modified, modified, c.getString(2), null, rel))
          }
        }
      }
    }
    batch.flush()
  }

  // ------------------------------------------------------------ opening an item

  /** What [open] found: a descriptor Rust takes over, or why there is none. */
  sealed class Opened {
    class Fd(val fd: Int, val size: Long) : Opened()
    /** not on the phone any more */
    object Gone : Opened()
    class Failed(val error: String) : Opened()
  }

  /**
   * Opens a pending item. Camera roll items are opened as the original (with the location in
   * their EXIF) when Kybl may read it (ACCESS_MEDIA_LOCATION); else Android strips it.
   */
  fun open(ctx: Context, set: JSONObject, sourceId: String, kind: String): Opened {
    val source = set.getJSONObject("source")
    return try {
      if (source.getString("type") == "androidTree") {
        val tree = Uri.parse(source.getString("uri"))
        fd(ctx, DocumentsContract.buildDocumentUriUsingTree(tree, sourceId))
      } else {
        val volume = sourceId.substringBeforeLast(':')
        val id = sourceId.substringAfterLast(':').toLongOrNull() ?: return Opened.Gone
        val uri = ContentUris.withAppendedId(collection(volume, kind == "video"), id)
        if (Build.VERSION.SDK_INT >= 29 && granted(ctx, Manifest.permission.ACCESS_MEDIA_LOCATION)) {
          try {
            return fd(ctx, MediaStore.setRequireOriginal(uri))
          } catch (e: SecurityException) {
            // not ours to read in full (a partial-access grant): the plain one below
          } catch (e: UnsupportedOperationException) {
          }
        }
        fd(ctx, uri)
      }
    } catch (e: FileNotFoundException) {
      Opened.Gone
    } catch (e: IllegalArgumentException) {
      Opened.Gone
    } catch (e: SecurityException) {
      Opened.Failed(
        if (source.optString("type") == "androidTree") "Kybl can't open this folder any more. Remove this backup and pick the folder again."
        else "Kybl isn't allowed to read this photo."
      )
    } catch (e: Exception) {
      Opened.Failed(e.message ?: "Couldn't open this file.")
    }
  }

  private fun fd(ctx: Context, uri: Uri): Opened {
    val pfd: ParcelFileDescriptor = ctx.contentResolver.openFileDescriptor(uri, "r") ?: return Opened.Gone
    val size = pfd.statSize
    return Opened.Fd(pfd.detachFd(), size)
  }
}
