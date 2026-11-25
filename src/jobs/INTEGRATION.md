# Jobs UI: how the desktop and phone apps mount it

Copies and moves between connections run as backend jobs (`job_*` commands, `job-progress`
event, see the WP-B1 section at the end of `src/core/api.ts`). Everything the hosts need is exported
from `src/jobs/index.ts`. Each component imports `jobs.css` itself.

```ts
import {
  startMigrations, onJobFinished, useActiveJobCount,
  MigrationDialog, JobsPanel, type MigrationSource,
} from "./jobs";
```

## 1. Start the store once (both apps)

In `App.tsx` and `MobileApp.tsx`, once at start-up (next to the transfer/sync listeners):

```ts
useEffect(() => {
  startMigrations(); // idempotent: loads job_list, listens to job-progress and app-resumed
  return onJobFinished((j) => {
    const p = j.progress;
    if (p.state === "done")
      toast(p.filesFailed ? `${j.title}: ${p.filesFailed} couldn't be copied` : `${j.title}: done`);
    else if (p.state === "failed") toast(`${j.title} stopped: ${errSummary(p.error ?? "")}`);
  });
}, []);
```

Jobs keep running in the backend with the window closed (tray) and survive restarts; the store
reloads the list whenever the page comes back.

## 2. Desktop

### Context menu: "Copy to another connection…"

For a selection of entries in the current connection / bucket (`entries`, with `kind`, `key`,
`size`):

```tsx
const [migrate, setMigrate] = useState<{ source: MigrationSource; mode: "copy" | "move" } | null>(null);

// menu item (also fine for a single file or folder), next to "Copy to…" / "Move to…"
{ label: "Copy to another connection…", run: () => setMigrate({
    mode: "copy",
    source: {
      profileId, root: bucket,
      items: entries.map((e) => ({ path: e.key, isDir: e.kind === "folder", size: e.kind === "folder" ? undefined : e.size })),
    },
  }) }

{migrate && (
  <MigrationDialog
    source={migrate.source}
    initialMode={migrate.mode}
    onClose={() => setMigrate(null)}
    onStarted={() => { setActivityTab("jobs"); setActivityOpen(true); }}
  />
)}
```

Folder keys end with `/`. Sizes are optional: the dialog counts folders itself (`folderSize`,
cancelled when it closes) for its summary sentence.

### Connection menu: "Copy everything to…"

A whole bucket/root is one folder item with path `""` (its contents land directly in the picked
folder):

```ts
setMigrate({ mode: "copy", source: { profileId, root: bucketOrRootId, items: [{ path: "", isDir: true }] } });
```

For "everything in this connection" with several buckets, open the dialog per bucket (or start
one job per root with `migrations.create`, each into `dest.dir + rootName + "/"`).

### Dual pane F5 / F6 across connections

When the two panes show different connections (or different roots where a server copy isn't
possible), F5 (copy) / F6 (move) should start a job instead of `moveMany`. Either open the dialog
with the other pane's folder preselected:

```tsx
<MigrationDialog source={src} initialMode={f6 ? "move" : "copy"}
  initialDest={{ profileId: other.profileId, root: other.bucket, dir: other.prefix }} onClose={...} />
```

or skip the dialog and create the job directly with the user's last options:

```ts
import { migrations } from "./jobs";
await migrations.create({
  mode: f6 ? "move" : "copy",
  src: { profileId: a.profileId, root: a.bucket, items },
  dst: { profileId: b.profileId, root: b.bucket, dir: b.prefix },
  conflict: "skipIdentical", verify: "hash", preserveMtime: true,
  ignore: [".DS_Store", "Thumbs.db", "desktop.ini"],
  title: `${items.length} items to ${otherName}`,
});
```

Same connection + same root keeps using the existing `moveMany` path (it's instant and already
handles renames).

### "Jobs" tab next to Activity (TransferPanel)

`TransferPanel` gets two tabs in its header: **Activity** (what it shows now) and **Jobs**:

```tsx
const jobsActive = useActiveJobCount();
<button className={tab === "jobs" ? "on" : ""} onClick={() => setTab("jobs")}>
  Jobs {jobsActive > 0 && <span className="pill accent">{jobsActive}</span>}
</button>

{open && tab === "jobs" && (
  <div className="tp-list"><JobsPanel onOpenDest={(j) => openLocation(j.spec.dst.profileId, j.spec.dst.root, j.spec.dst.dir)} /></div>
)}
```

The panel should also show (and count in its "active" pill) when only jobs are running.
`JobsPanel` props: `variant?: "desktop" | "mobile"`, `onOpenDest?(job)`, `limit?` (finished jobs
listed, default 30), `hideWhenEmpty?`.

### Quit prompt

Already handled in the backend (`app/quit.rs` counts running jobs). Nothing to do in the page.

## 3. Phones

### Folder "More" menu → "Copy to another connection…"

Same `MigrationDialog`; inside `.m-app` the shared `Modal` renders as a bottom sheet and the tree
rows grow to touch size, so no separate screen is needed:

```tsx
{ label: "Copy to another connection…", icon: "copy", run: () => setMigrate({ mode: "copy",
    source: { profileId, root: bucket, items: [{ path: folderPrefix, isDir: true }] } }) }
```

(For the bucket's own More menu use `path: ""`.) Wire the system back button to close it like
other sheets (`useSystemBack`).

### Transfers screen section

Under the transfer list in `TransfersScreen.tsx`:

```tsx
<section>
  <h3 className="m-section-title">Copies between connections</h3>
  <JobsPanel variant="mobile" hideWhenEmpty onOpenDest={(j) => openFolder(j.spec.dst)} />
</section>
```

and add `useActiveJobCount()` to the Transfers tab badge. On Android the backend keeps the process
alive through the transfer notification while a job runs. On iOS a running job holds the same
background task as transfers (about half a minute after the app is left); after that its
requests fail and it shows "waiting for the network" until the app comes back, when
`app-resumed` makes it carry on at once (the store re-lists then too). Nothing to do in the page.

## 4. Looking at it in a browser

`pnpm exec vite --port 1455` and open `http://localhost:1455/src/jobs/dev/dev.html` (`?mobile` for
the phone look). It uses `devMock.ts` → `src/jobs/dev/devJobs.ts`, which simulates a running, a
paused and a finished-with-problems job, and runs new jobs from the dialog.
