/**
 * Every file under a folder of a connection, handed over as the backend finds them (a Tauri
 * Channel), so a folder download starts with the first files instead of after the whole tree was
 * listed: thousands of folders on an FTP server take minutes to list.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { RemoteFile } from "./types";

/** Listings running now, by op id: what stops each (Stop on the busy line, Cancel all). */

const running = new Map<string, (why: StopReason) => void>();

/** Stops every folder listing still running (Cancel all): no more files are handed over. */
export function stopListings(): void {
  for (const stop of [...running.values()]) stop("all");
}

/** "one": Stop on that listing (what was found keeps going); "all": Cancel all (everything stops). */
export type StopReason = "one" | "all";

/** A listing that ended because it was stopped, not because it failed. */
export class ListingStopped extends Error {
  constructor(readonly reason: StopReason) {
    super("Stopped");
  }
}

/**
 * Calls `onBatch` with each batch of files found under `prefix` and resolves with how many there
 * were, once all of them were handed over. `stop()` on the returned handle (or `stopListings()`)
 * ends it early: no batch is handed over after that and `done` rejects with `ListingStopped`.
 */
export function eachFileUnder(profileId: string, bucket: string, prefix: string, onBatch: (files: RemoteFile[]) => void): { done: Promise<number>; stop: () => void } {
  const opId = crypto.randomUUID();
  let got = 0;
  let want: number | null = null;
  let stopped = false;
  let reason: StopReason = "one";
  let finish: () => void = () => {};
  const allIn = new Promise<void>((ok) => (finish = ok));
  // a stop settles `done` at once: a listing stuck on a slow or silent server may take a minute
  // to notice the cancel, and the person who pressed Stop shouldn't wait for it
  let halt: (e: ListingStopped) => void = () => {};
  const halted = new Promise<never>((_, no) => (halt = no));
  const stop = (why: StopReason = "one") => {
    if (stopped) return;
    stopped = true;
    reason = why;
    running.delete(opId);
    finish();
    halt(new ListingStopped(why));
    void invoke("cancel_transfer", { id: opId }).catch(() => {});
  };
  running.set(opId, stop);
  const ch = new Channel<RemoteFile[]>();
  ch.onmessage = (files) => {
    if (stopped) return;
    got += files.length;
    onBatch(files);
    if (want !== null && got >= want) finish();
  };
  const listed = invoke<number>("stream_files_under", { profileId, bucket, prefix, opId, onBatch: ch })
    .then(async (n) => {
      // the answer can overtake the last batches on their way: wait for them (briefly)
      want = n;
      if (got < n) await Promise.race([allIn, new Promise((ok) => setTimeout(ok, 2000))]);
      if (stopped) throw new ListingStopped(reason);
      return n;
    })
    .catch(async (e) => {
      // batches found before the failure may still be on their way: let them land first, so
      // the caller reports (and builds its list of downloads) after all of them were handed over
      if (!stopped) await new Promise((ok) => setTimeout(ok, 300));
      const byUser = stopped;
      // none after the failure was reported
      stopped = true;
      throw byUser ? new ListingStopped(reason) : e;
    })
    .finally(() => running.delete(opId));
  // whichever comes first; the other one's outcome is dropped
  listed.catch(() => {});
  halted.catch(() => {});
  const done = Promise.race([listed, halted]);
  return { done, stop: () => stop("one") };
}
