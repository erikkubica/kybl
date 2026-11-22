import { SyncDialog } from "../components/SyncDialog";
import { syncApi, useSync } from "../sync";
import type { Profile } from "../types";

/**
 * "Sync this folder…" from the file browser: the sync dialog, prefilled with the connection,
 * bucket and folder on screen. A component of its own so the live sync status it subscribes to
 * re-renders only this dialog, not the whole window.
 */
export function SyncThisFolder({
  profiles,
  profileId,
  bucket,
  prefix,
  onDone,
  onClose,
}: {
  profiles: Profile[];
  profileId: string;
  bucket: string;
  prefix: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const sync = useSync();
  return (
    <SyncDialog
      initial={null}
      prefill={{ profileId, bucket, prefix }}
      profiles={profiles}
      defaultProfileId={profileId}
      onSave={async (m) => {
        await syncApi.save(m);
        await sync.reload();
        onDone();
      }}
      onClose={onClose}
    />
  );
}
