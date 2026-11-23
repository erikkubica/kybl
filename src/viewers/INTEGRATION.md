# Wiring the document viewers into the app

Everything in `src/viewers` is self-contained. The app touches it through two imports:

```ts
import { viewerFor, canView, LazyDocumentView } from "../viewers/registry"; // tiny, safe to import anywhere
import type { DocumentHandle } from "../viewers/DocumentView";            // type only, costs nothing
```

`registry.ts` holds only data and `import()` calls. `LazyDocumentView` is `React.lazy(() => import("./DocumentView"))`,
so mounting it pulls DocumentView, its CSS and the one viewer it needs on first use. **Never import
`DocumentView.tsx` (or any viewer) statically** from App/MobileApp/PreviewPane/QuickLook, or CodeMirror lands in the first-load bundle.

Measured with the registry imported from PreviewPane: first-load JS grows by about 4.5 KB (about 1.8 KB gzipped),
mostly the preload lists for the viewer chunks. Everything else is lazy.

## The pieces

| Export | What it is |
|---|---|
| `viewerFor(name, contentType?, size?)` | `ViewerInfo \| null`: `{ kind, canEdit, maxBytes, editMaxBytes, load }`. `kind` is one of `text`, `json`, `markdown`, `csv`, `docx`, `xlsx`, `pptx`, `image`. `canEdit` is already false above the 5 MB editing limit when `size` is given. |
| `canView(name, size, contentType?)` | Whether the full view opens this file in the app at that size. Use it to decide between "Open" and "Open in another app". |
| `<LazyDocumentView … />` | Wrap in `<Suspense fallback={…}>`. Props below. |
| `DocumentHandle` | Via `ref`: `requestClose(): Promise<boolean>`, `isDirty()`, `save(): Promise<boolean>`. |

### `DocumentView` props

```ts
profileId: string;
bucket: string;
entry: Entry;                       // a file Entry from the listing
mode: "preview" | "full";
onClose?: () => void;               // full: close button, Esc, "Don't save"
onSaved?: (s: { key: string; meta: DocMeta; asCopy: boolean }) => void;
onOpenExternal?: (entry: Entry) => void;  // shows "Open in another app" when given
onOpenFull?: (entry: Entry) => void;      // preview: shows an "Edit"/"Open" button
inline?: boolean;                   // full: fill the parent instead of covering the window
ref?: Ref<DocumentHandle>;
```

- **preview**: read-only and compact; smaller download limits (2 MB text, 10 MB CSV, 15 MB Word/Excel,
  25 MB images, 30 MB slides). Above the limit it shows the size with "Open" (→ `onOpenFull`) and
  "Open in another app" (→ `onOpenExternal`).
- **full**: by default `position: fixed; inset: 0; z-index: 150` (above `.modal-backdrop`, below the
  context menu and toasts). Header with close, name, "Edited / Saving… / Saved / Read only", Save. Handles
  ⌘S / Ctrl+S (⇧⌘S saves as a copy), Esc (asks about unsaved changes), conflicts (Reload / Overwrite /
  Save as copy; "deleted meanwhile" offers Save it again / Save as copy), read-only notices (not UTF-8,
  over 5 MB). On macOS desktop it leaves room for the window buttons and is a drag region.
- Saving keeps the file's encoding, BOM and line endings, and on the backend its Content-Type,
  Cache-Control, Content-Disposition, Content-Encoding, user metadata, storage class and tags.

## 1. Previews: Quick Look (desktop) and PreviewPane (phones)

Desktop has no details panel: Space opens Quick Look (`src/desktop/QuickLook.tsx`), which shows the
preview with an info column beside it (`src/components/EntryInfo.tsx`; ⌘I or "Get Info" opens it that
way). Its `Content` uses the same `viewerFor` + `<LazyDocumentView mode="preview">` pattern as below,
filling the Quick Look body. Phones keep `src/components/PreviewPane.tsx`: the preview over the same
`EntryInfo`. The snippet below is how PreviewPane wires it.

Keep the existing image (thumbnail / presigned URL), video, audio and PDF paths. Replace the plain
`textPreview` `<pre>` (and the "No preview for this file type" note for Office files) with the preview mode:

```tsx
const viewer = !isFolder ? viewerFor(entry.name, details?.contentType, entry.size) : null;
// images keep the thumbnail flow above; the viewer covers text, code, JSON, Markdown, CSV, Word, Excel, slides
const showsDoc = !!viewer && viewer.kind !== "image";

// in .preview-media (give it the "doc" modifier so it can grow, see CSS below):
{showsDoc && (
  <Suspense fallback={<div className="preview-note"><span className="spinner" /></div>}>
    <LazyDocumentView
      key={entry.key}
      profileId={profileId}
      bucket={bucket}
      entry={entry}
      mode="preview"
      onOpenFull={onOpenFull}          // new PreviewPane prop, wired to App's "open in editor"
      onOpenExternal={onOpenExternal}  // new prop: phase-1 "open in default app" (download + api.openLocal)
    />
  </Suspense>
)}
```

and drop the `textPreview` effect branch for files `showsDoc` covers (`unsupported` must also exclude
`showsDoc`). The preview fills its container: give `.preview-media.doc` a fixed height (e.g.
`height: 300px; display: flex; flex-direction: column; padding: 0; background: var(--bg)`).

## 2. Desktop "Open" (full-window editor) in `App.tsx`

```tsx
const [editing, setEditing] = useState<Entry | null>(null);
const editor = useRef<DocumentHandle>(null);

// Enter / double-click on a file, the context menu ("Open" for viewable files, "Edit" when canEdit),
// and PreviewPane's onOpenFull:
const openInApp = (e: Entry) => (canView(e.name, e.size) ? setEditing(e) : openExternally(e));

{editing && profile && bucket && (
  <Suspense fallback={null}>
    <LazyDocumentView
      ref={editor}
      profileId={profile.id}
      bucket={bucket}
      entry={editing}
      mode="full"
      onClose={() => setEditing(null)}
      onSaved={({ key, asCopy }) => {
        refresh();                                   // re-list: size, modified, ETag changed
        if (asCopy) toast("ok", `Saved a copy as ${baseName(key)}`);
      }}
      onOpenExternal={openExternally}               // phase 1: download to tempFolder, then api.openLocal
    />
  </Suspense>
)}
```

- While `editing` is set, the browser underneath must not react to keys: skip the app's global
  shortcuts when `editing` is non-null (the editor owns ⌘S, ⌘F, Esc, arrows).
- Menu-bar events (`menu`) that navigate away or quit while the editor is open: `await editor.current?.requestClose()`
  first and only continue when it resolves `true`.
- Window close (`CloseRequested` hides to the tray, so nothing is lost); app quit with unsaved changes is
  not intercepted yet. If wanted: `getCurrentWindow().onCloseRequested(async (ev) => { if (editor.current?.isDirty()) { ev.preventDefault(); if (await editor.current.requestClose()) getCurrentWindow().close(); } })`.
- A separate Tauri window per document can come later; DocumentView doesn't assume the main window.

## 3. Mobile (`src/mobile/MobileApp.tsx` + `Viewer.tsx`)

`Viewer.tsx` stays the photo/video viewer (swipe between media, pinch, drag to dismiss). Documents get
their own screen. In `openEntry`:

```tsx
else if (isMedia(e) && !wide) setViewer(media.findIndex((m) => m.key === e.key));
else if (canView(e.name, e.size)) setDoc(e);       // new
else setDetail(e);
```

Render it as an overlay screen, inline so it sits in the app's own stacking order (sheets, toasts):

```tsx
{doc && loc && (
  <div className="m-screen m-overlay">
    <Suspense fallback={null}>
      <LazyDocumentView
        ref={docRef}
        inline
        profileId={loc.profileId}
        bucket={loc.bucket}
        entry={doc}
        mode="full"
        onClose={() => setDoc(null)}
        onSaved={() => { reload(); api.haptic("success"); }}
        onOpenExternal={openWith}                  // phase 1: download, then api.openLocal ("Open with…")
      />
    </Suspense>
  </div>
)}
```

- Back gesture / Android back button: route it through `docRef.current?.requestClose()` (it asks about unsaved
  changes and calls `onClose` when it really closes). Hook it into the existing `backRef` / `popstate` handling.
- Safe areas: the header pads by `--a-top` / `env(safe-area-inset-top)`, toolbars and the sheet tabs by the
  left/right/bottom insets; dialogs become bottom sheets under 700 px. Touch targets are 44 px on coarse pointers,
  editable text is 16 px (no iOS zoom), read-only text never raises the keyboard.
- The detail sheet (`setDetail`) can show the preview too: same snippet as PreviewPane with `mode="preview"`.
- Images: `kind === "image"` is handled by `ImageView` (zoom, pinch) if a provider can't presign (WP-A4); until
  then keep using `Viewer.tsx` for media.

## 4. Backend contract (`src-tauri/src/doc.rs`)

- `doc_open { profileId, root, path, maxBytes }` → raw body `[u32 BE json_len][json DocMeta][bytes]`.
  Use `docOpen()` in `api.ts`; it parses the frame.
- `doc_save` raw body + headers `x-kybl-profile`, `x-kybl-root`, `x-kybl-path`, `x-kybl-expect` (all
  percent-encoded; `expect` is JSON `DocPrecondition`). Use `docSave()`; it throws `DocConflict { current }`
  on `CONFLICT\n\n{json|null}`.
- Conditional writes: `If-Match` / `If-None-Match: *` on AWS and R2; HEAD-compare-then-PUT elsewhere
  (Hetzner, Kybl Storage, other S3). Either way the HEAD runs first, so headers and tags are carried over.
- When the WP0 storage core lands, `s3_read` / `s3_stat` / `s3_write` become `Storage::read` / `stat` /
  `write`, and `guard_for(provider)` becomes `caps.conditionalWrite`. Nothing in the frontend changes.

## 5. Trying it without the app

`pnpm exec vite --port 1448`, then <http://localhost:1448/src/viewers/dev.html> (`?dark`, or
`?open=docs/notes.md` for just the full view at phone size). `devMock.ts` answers `doc_open` /
`doc_save` with generated samples (Markdown with a script injection attempt, JSON, CSV incl. 200 000 rows,
TypeScript with BOM + CRLF, YAML, Latin-1 log, Word, Excel with 3 sheets, slides, SVG); "Change it
elsewhere" / "Delete it elsewhere" in the harness trigger the conflict dialogs.
