/**
 * A file fetched into the app's temporary folder, for handing to other apps: "Open in…", sharing
 * the file itself, and "Save to Photos". These don't go through the Transfers list (they are a
 * means to an end, and the temporary folder is cleaned when the app starts); progress comes from
 * the same `transfer` events, matched by id.
 */
import { listen } from "@tauri-apps/api/event";
import { api, errMessage } from "../api";
import { safeName } from "../desktop/paths";
import type { TransferEvent } from "../types";

type Source = { profileId: string; bucket: string; key: string; name: string; etag?: string | null; size: number; modified?: number | null };

/** Files already fetched this session, so Share after Open in… doesn't download twice. */
const done = new Map<string, string>();
// with the modified time too: FTP, SFTP and WebDAV often give no etag, and an edit can keep the size
const idOf = (s: Source) => `${s.profileId}|${s.bucket}|${s.key}|${s.etag ?? ""}|${s.size}|${s.modified ?? ""}`;

// the app removed copies nobody used for long ("Clear cache", the weekly trim): fetch them again
let watching = false;
function watchRemovals() {
  if (watching) return;
  watching = true;
  listen("open-copies-removed", () => done.clear()).catch(() => {
    watching = false;
  });
}

export type LocalCopy = {
  /** the local path once it is there */
  path: Promise<string>;
  cancel: () => void;
};

let tempDir: Promise<string> | null = null;

/** Whether a copy made earlier is still a file at `path`. */
async function stillThere(path: string): Promise<boolean> {
  try {
    const found = await api.expandPaths([path]);
    return found.length === 1 && found[0].path === path;
  } catch {
    return false;
  }
}

/** Starts fetching; `onProgress` gets 0..1 (or null while the size is unknown). */
export function localCopy(src: Source, onProgress?: (frac: number | null) => void): LocalCopy {
  watchRemovals();
  const id = crypto.randomUUID();
  let cancelled = false;
  const path = (async () => {
    // a copy fetched earlier is used again only while it is still there: "Clear cache" and the
    // weekly trim remove copies other apps are done with
    const have = done.get(idOf(src));
    if (have) {
      if (await stillThere(have)) return have;
      done.delete(idOf(src));
    }
    tempDir ??= api.tempFolder().catch((e) => {
      tempDir = null;
      throw e;
    });
    const dir = (await tempDir).replace(/[\\/]$/, "");
    // a folder per file keeps the original name, which is what the other app shows
    const dest = `${dir}/share/${id.slice(0, 8)}/${safeName(src.name) || "file"}`;
    let finish: (ok: boolean, err?: string) => void = () => {};
    const ended = new Promise<void>((ok, fail) => {
      finish = (good, err) => (good ? ok() : fail(new Error(err ?? "Download failed")));
    });
    const off = await listen<TransferEvent>("transfer", (e) => {
      const ev = e.payload;
      if (ev.id !== id) return;
      if (ev.state === "running") onProgress?.(ev.total ? ev.bytes / ev.total : null);
      else if (ev.state === "done") finish(true);
      else if (ev.state === "error") finish(false, ev.error ?? undefined);
      else if (ev.state === "cancelled") finish(false, "Cancelled");
    });
    try {
      if (cancelled) throw new Error("Cancelled");
      const written = await api.startDownload(id, src.profileId, src.bucket, src.key, dest, true);
      await ended;
      const at = written || dest;
      done.set(idOf(src), at);
      return at;
    } catch (e) {
      throw new Error(errMessage(e));
    } finally {
      off();
    }
  })();
  return {
    path,
    cancel: () => {
      cancelled = true;
      api.cancelTransfer(id).catch(() => {});
    },
  };
}
