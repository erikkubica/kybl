/**
 * Every file under a folder of a connection, handed over as the backend finds them (a Tauri
 * Channel), so a folder download starts with the first files instead of after the whole tree was
 * listed: thousands of folders on an FTP server take minutes to list.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { RemoteFile } from "./types";

/**
 * Calls `onBatch` with each batch of files found under `prefix` and resolves with how many there
 * were, once all of them were handed over. `opId` stops it early (`api.cancelTransfer(opId)`).
 */
export function eachFileUnder(profileId: string, bucket: string, prefix: string, onBatch: (files: RemoteFile[]) => void, opId: string = crypto.randomUUID()): Promise<number> {
  let got = 0;
  let want: number | null = null;
  let finish: () => void = () => {};
  const allIn = new Promise<void>((ok) => (finish = ok));
  const ch = new Channel<RemoteFile[]>();
  ch.onmessage = (files) => {
    got += files.length;
    onBatch(files);
    if (want !== null && got >= want) finish();
  };
  return invoke<number>("stream_files_under", { profileId, bucket, prefix, opId, onBatch: ch }).then(async (n) => {
    // the answer can overtake the last batches on their way: wait for them (briefly)
    want = n;
    if (got < n) await Promise.race([allIn, new Promise((ok) => setTimeout(ok, 2000))]);
    return n;
  });
}
