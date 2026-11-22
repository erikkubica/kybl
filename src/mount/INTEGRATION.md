# Drives ("Mount as drive"): wiring notes

Stage E4 of `docs/phase2-architecture.md` §5. Desktop only: the Rust side is `src-tauri/src/mount/`
(`#[cfg(desktop)]`); on phones the commands don't exist and `useMounts()` shows an empty list.

## What's here

| File | What |
|---|---|
| `useMounts.ts` | shared live list (`mount_list` + `mount-status` events), `findMount`, `fileManagerName()` ("Finder" / "File Explorer" / "file manager"), `mountWhere` |
| `MountsSection.tsx` | Settings › Drives: list with status, upload progress, conflict notices, Show in Finder, Unmount / Mount / Try again, Remove |
| `MountDialog.tsx` | "Mount as drive…": names the drive and mounts it; offers "Show in Finder" when the place already is a drive |
| `mount.css` | the few styles on top of the sync card styles |

API (end of `src/api.ts`, `// WP-E4`): `mountApi.mountList / mountAdd(profileId, bucket, prefix, name?) / mountRemove / mountReveal / mountRetry / mountEject / mountDismiss`, type `MountInfo`, event `MOUNT_STATUS_EVENT` (`"mount-status"`, payload `MountInfo`, state `"removed"` when deleted). `src/devMock.ts` answers all of them (`?nodrives` for the empty state).

## Already wired

- `SettingsPage.tsx`: page id `"drives"` ("Drives", under Storage) renders `<MountsSection profiles onToast />`.
- The tray's **Drives** submenu opens a mounted drive in Finder, and "Drive settings…" emits `open-settings` with `"drives"` (AppShell already listens).
- `quit.rs` asks before quitting while saves on drives still wait to upload, and unmounts on the way out.

## For the manager to wire: the context menu

Add **Mount as drive…** (icon `server`) to:

1. the sidebar bucket menu (`AppShell.bucketMenu`): `prefix = ""`;
2. the folder row menu (`useEntryActions`, next to "Sync this folder…"): `prefix = e.key` (ends with `/`);
3. optionally the connection menu: `bucket = ""`, `prefix = ""` mounts the whole connection. Every root (bucket, drive) becomes a top-level folder; a connection with one root (SFTP, FTP, WebDAV, Dropbox) shows that root's contents directly.

Show it on desktop only (not `?mobile` / `MobileApp`), and hide it for `THIS_MAC` (mounting your own disk makes no sense). It works for every connection kind behind `Storage` (S3, SFTP, FTP, WebDAV, Drive, OneDrive, Dropbox, Azure, GCS).

```tsx
import { MountDialog } from "../mount/MountDialog";

const [mountAsk, setMountAsk] = useState<{ p: Profile; bucket: string; prefix: string } | null>(null);
// menu item:
{ type: "item", label: "Mount as drive…", icon: "server", onClick: () => setMountAsk({ p, bucket: b, prefix: "" }) },
// with the other dialogs (render it after the main layout so it stacks above):
{mountAsk && (
  <MountDialog
    profileId={mountAsk.p.id}
    connection={mountAsk.p.name}
    bucket={mountAsk.bucket}
    prefix={mountAsk.prefix}
    onClose={() => setMountAsk(null)}
    onToast={toast}
    onOpenSettings={() => openSettings("drives")}
  />
)}
```

On success the dialog shows a toast and opens the drive in Finder. If the system refuses (e.g. Windows, or `gio` missing on Linux) the error shows in the dialog and the drive stays listed in Settings › Drives with "Try again".

## Behaviour worth knowing when testing

- macOS mounts with `mount_webdav -S` into `~/Library/Application Support/app.kybl.desktop/Mounts/<name>`; no password prompt, no admin rights. It appears in Finder's sidebar under Locations.
- Saves upload ~1.5 s after the last write (an empty new file waits 20 s: Finder creates it empty first). A file changed on the server meanwhile is uploaded as `name (conflict YYYY-MM-DD HH.MM).ext` and the drive shows a notice.
- `._*`, `.DS_Store`, Spotlight and Trash folders never reach the storage.
- Remove refuses while saves from the drive still wait to upload.
- Windows: not offered ("Drives aren't available on Windows yet…"); `KYBL_EXPERIMENTAL_WEBDAV_DRIVE=1` tries `net use` (untested). See `src-tauri/src/mount/NATIVE.md`.
