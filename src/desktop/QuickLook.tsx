import { keys } from "../components/osText";
import { Suspense, useEffect, useRef, useState } from "react";
import { api, errMessage } from "../api";
import { Icon } from "../Icons";
import { classify, formatBytes, formatDateFull, isWebImage, entrySize, entryKind } from "../format";
import { FileIcon } from "../components/FileIcon";
import { ErrorText } from "../components/ErrorText";
import { MAX_PDF_BYTES, PdfView } from "../components/PdfView";
import { EntryInfo, FolderSizeLine, SelectionInfo, useObjectHead, type SizeProps } from "../components/EntryInfo";
import type { Entry } from "../types";
import { imageUrl, playableUrl } from "../media";
import { cachedThumb, canThumb, loadThumb, onThumbReady } from "../thumbs";
import { usePlaceholder } from "../thumbhash";
import { asExport } from "../connections/native";
// the same previews as the phone's details screen (components/PreviewPane): documents in the
// document viewer, images the web view can't draw by their thumbnail, Google files by their Office export
import { LazyDocumentView, viewerFor } from "../viewers/registry";
import { releaseOnUnmount } from "../releaseMedia";
import { useLocalCopy } from "../localCopyProgress";
import { useRevealHit } from "./revealHit";
import type { ContentHit } from "../browser/devtoolsApi";

const MAX_TEXT = 50 * 1000 * 1000;
/** the info column shows by itself (until it is switched off or on) in a window at least this wide */
const INFO_MIN_WINDOW = 900;
/** at most this many tiles for a selection shown together */
const SHEET_MAX = 240;

/** What the info column does with the item (desktop: the pane's own file actions). */
export type QuickInfoActions = SizeProps & {
  /** share-link lifetime preselected from Settings, in seconds */
  defaultExpiry: number;
  onCopyLink(e: Entry, secs: number): void;
  onCopyText(text: string, what: string): void;
  /** absent on this computer's own disk */
  onDownload?(list: Entry[]): void;
  onRename(e: Entry): void;
  onMoveTo(list: Entry[]): void;
  onDelete(list: Entry[]): void;
  /** properties saved, or the file turned out to be gone: list the folder again */
  onChanged?(): void;
  /** servers: "Permissions…" and a link's "Show original" */
  onPermissions?(list: Entry[]): void;
  onShowOriginal?(e: Entry): void;
  /** "Edit" for text-like files: the edit menu at the button (src/edit) */
  onEdit?(e: Entry, at: { x: number; y: number }): void;
};

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

/**
 * Space bar preview, like Quick Look in Finder: a large look at the selected file over the list,
 * with an info column beside it (Finder's Get Info: name, actions, share link, size, date, place,
 * technical details), toggled with its (i) button or ⌘I and remembered. ⌘I in the list opens it
 * that way ("Get Info"), for folders too, and for several items together.
 *
 * Arrow keys page through the files around it, Space or Escape closes it, Enter or ⌘O opens the
 * file in its default app. Keys typed into a field of the info column stay there.
 */
export function QuickLook({
  profileId,
  bucket,
  entry,
  group,
  index,
  count,
  startWithInfo,
  hit,
  infoPref,
  onInfoPref,
  info: act,
  onStep,
  onPick,
  onClose,
  onOpen,
  onDownload,
  onCopyFile,
  onOpenExternal,
}: {
  profileId: string;
  bucket: string;
  entry: Entry;
  /** several items shown together (Get Info on a selection), instead of `entry` */
  group?: Entry[] | null;
  /** position among the list's entries, for "3 of 40" */
  index: number;
  count: number;
  /** opened by Get Info: the info column shows whatever it was left at */
  startWithInfo?: boolean;
  /** opened from a search inside files: the preview scrolls to this matching line */
  hit?: ContentHit;
  /** the info column's setting: on, off, or null for "if the window is wide enough" */
  infoPref: boolean | null;
  onInfoPref(on: boolean): void;
  info: QuickInfoActions;
  onStep: (delta: number) => void;
  /** one item of `group` on its own */
  onPick: (e: Entry) => void;
  onClose: () => void;
  onOpen: (e: Entry) => void;
  /** absent on this computer's own disk */
  onDownload?: (e: Entry) => void;
  /** the file itself on the clipboard (⌘C here), to paste into a chat or a folder */
  onCopyFile?: (e: Entry) => void;
  /** documents: "Open in another app" */
  onOpenExternal?: (e: Entry) => void;
}) {
  // a Copy or Open of this file still downloading shows on its button
  const busy = useLocalCopy(profileId, bucket, entry.key);
  const bodyRef = useRef<HTMLDivElement>(null);
  useRevealHit(bodyRef, entry.key, hit);
  const working = !!busy;
  const many = !!group && group.length > 1;
  const isFile = entry.kind === "file" && !many;
  const [infoOpen, setInfoOpen] = useState(() => !!startWithInfo || (infoPref ?? window.innerWidth >= INFO_MIN_WINDOW));
  const toggleInfo = () => {
    const next = !infoOpen;
    setInfoOpen(next);
    onInfoPref(next);
  };
  const toggleRef = useRef(toggleInfo);
  toggleRef.current = toggleInfo;
  // the share link's lifetime stays as picked from one file to the next
  const [expiry, setExpiry] = useState(act.defaultExpiry);
  const sheet = useRef<HTMLDivElement>(null);

  // the list underneath must not see these keys while the preview is up
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // a dialog over the preview (Delete asks first) has the keyboard
      if (document.querySelector(".modal-backdrop, .ctx-menu")) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      // typing in the info column (Edit properties): only Escape leaves the field, and ⌘I still toggles
      if (isTyping(e.target)) {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        else if (!(mod && k === "i")) return;
      }
      // a button of the info column reached with the keyboard: Space and Enter press it
      const t = e.target as HTMLElement;
      if ((e.key === " " || e.key === "Enter") && sheet.current?.contains(t) && t.closest("button, a[href], [role=button]") && t.matches(":focus-visible")) return;
      let handled = true;
      // (Escape in a field only let go of it, above: the preview stays)
      if (isTyping(e.target) && e.key === "Escape") handled = true;
      else if (mod && k === "i") toggleRef.current();
      else if (e.key === "Escape" || e.key === " ") onClose();
      else if (many && e.key.startsWith("Arrow")) handled = true;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") onStep(-1);
      else if (e.key === "ArrowRight" || e.key === "ArrowDown") onStep(1);
      else if (!many && (e.key === "Enter" || (mod && k === "o"))) onOpen(entry);
      else if (mod && (k === "w" || e.key === ".")) onClose();
      else if (mod && k === "c" && onCopyFile && isFile && !window.getSelection()?.toString()) {
        if (!working) onCopyFile(entry);
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [entry, many, isFile, onClose, onStep, onOpen, onCopyFile, working]);

  // the info column's actions: rename and move put the preview away (their dialog takes over)
  const rename = (e: Entry) => {
    onClose();
    act.onRename(e);
  };
  const moveTo = (list: Entry[]) => {
    onClose();
    act.onMoveTo(list);
  };
  const groupParts = many ? describe(group!) : "";

  return (
    <div className="ql-backdrop" onMouseDown={onClose}>
      <div
        ref={sheet}
        className={`ql ${infoOpen ? "with-info" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={many ? `${group!.length} items` : `${infoOpen ? "Info" : "Preview"} of ${entry.name}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="ql-head">
          {!many && (
            <>
              <button className="icon-btn" onClick={() => onStep(-1)} disabled={index <= 0} aria-label="Previous" title={keys("Previous (←)")}>
                <Icon name="chevron" size={14} className="ql-prev" />
              </button>
              <button className="icon-btn" onClick={() => onStep(1)} disabled={index >= count - 1} aria-label="Next" title={keys("Next (→)")}>
                <Icon name="chevron" size={14} />
              </button>
            </>
          )}
          <div className="ql-title">
            {many ? (
              <>
                <strong>{group!.length.toLocaleString()} items</strong>
                <span>{groupParts}</span>
              </>
            ) : (
              <>
                <strong title={entry.key}>{entry.name}</strong>
                <span>
                  {entry.kind === "file" ? `${entrySize(entry)} · ` : ""}
                  {entryKind(entry)}
                  {count > 1 ? ` · ${index + 1} of ${count.toLocaleString()}` : ""}
                </span>
              </>
            )}
          </div>
          {/* with the info column open, Copy and Download are in it */}
          {isFile && !infoOpen && (
            <>
              {onCopyFile && (
                <button
                  className={`btn btn-sm ${busy?.verb === "copy" ? "btn-progress" : ""}`}
                  style={busy?.verb === "copy" ? ({ "--p": `${busy.percent}%` } as React.CSSProperties) : undefined}
                  onClick={() => onCopyFile(entry)}
                  disabled={!!busy}
                  title={keys("Copy the file, to paste into a chat, a mail or a folder (⌘C)")}
                >
                  <Icon name="copy" size={14} /> {busy?.verb === "copy" ? `Copying ${busy.percent}%` : "Copy"}
                </button>
              )}
              {onDownload && (
                <button className="btn btn-sm" onClick={() => onDownload(entry)}>
                  <Icon name="download" size={14} /> Download
                </button>
              )}
            </>
          )}
          {!many && (
            <button
              className={`btn btn-sm btn-primary ${busy?.verb === "open" ? "btn-progress" : ""}`}
              style={busy?.verb === "open" ? ({ "--p": `${busy.percent}%` } as React.CSSProperties) : undefined}
              onClick={() => onOpen(entry)}
              disabled={!!busy}
              title={keys(entry.kind === "folder" ? "Open the folder (↵)" : "Open in its app (⌘O)")}
            >
              <Icon name={entry.kind === "folder" ? "folder" : "reveal"} size={14} /> {busy?.verb === "open" ? `Opening ${busy.percent}%` : "Open"}
            </button>
          )}
          <button
            className={`icon-btn ql-info-toggle ${infoOpen ? "on" : ""}`}
            onClick={toggleInfo}
            aria-pressed={infoOpen}
            aria-label="Info"
            title={keys(infoOpen ? "Hide info (⌘I)" : "Show info (⌘I)")}
          >
            <Icon name="info" />
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Space)">
            <Icon name="x" />
          </button>
        </div>
        <div className="ql-main">
          <div className="ql-body" ref={bodyRef}>
            {many ? (
              <GroupSheet profileId={profileId} bucket={bucket} group={group!} onPick={onPick} />
            ) : entry.kind === "folder" ? (
              <FolderLook key={entry.key} entry={entry} folderSize={act.folderSize} onCalcSize={act.onCalcSize} />
            ) : (
              <Content key={entry.key} profileId={profileId} bucket={bucket} entry={entry} onOpen={onOpen} />
            )}
          </div>
          {infoOpen && (
            <aside className="ql-info" aria-label="Info">
              {many ? (
                <SelectionInfo
                  selection={group!}
                  folderSize={act.folderSize}
                  onCalcSize={act.onCalcSize}
                  onDownload={act.onDownload && (() => act.onDownload!(group!))}
                  onMoveTo={() => moveTo(group!)}
                  onDelete={() => act.onDelete(group!)}
                />
              ) : (
                <QuickInfo
                  key={entry.key}
                  profileId={profileId}
                  bucket={bucket}
                  entry={entry}
                  act={act}
                  expiry={expiry}
                  onExpiry={setExpiry}
                  onRename={rename}
                  onMoveTo={moveTo}
                  onCopyFile={onCopyFile}
                  onOpenExternal={onOpenExternal}
                />
              )}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

/** "3 files and 2 folders" */
function describe(list: Entry[]) {
  const files = list.filter((e) => e.kind === "file").length;
  const folders = list.length - files;
  return [files && `${files.toLocaleString()} ${files === 1 ? "file" : "files"}`, folders && `${folders.toLocaleString()} ${folders === 1 ? "folder" : "folders"}`].filter(Boolean).join(" and ");
}

/** The info column for one item: what EntryInfo shows, with its object details read here. */
function QuickInfo({
  profileId,
  bucket,
  entry,
  act,
  expiry,
  onExpiry,
  onRename,
  onMoveTo,
  onCopyFile,
  onOpenExternal,
}: {
  profileId: string;
  bucket: string;
  entry: Entry;
  act: QuickInfoActions;
  expiry: number;
  onExpiry(secs: number): void;
  onRename(e: Entry): void;
  onMoveTo(list: Entry[]): void;
  onCopyFile?(e: Entry): void;
  onOpenExternal?(e: Entry): void;
}) {
  const head = useObjectHead(profileId, bucket, entry);
  return (
    <div className="ql-info-inner">
      <EntryInfo
        variant="sheet"
        profileId={profileId}
        bucket={bucket}
        entry={entry}
        head={head}
        defaultExpiry={act.defaultExpiry}
        expiry={expiry}
        onExpiry={onExpiry}
        onCopyLink={(secs) => act.onCopyLink(entry, secs)}
        onCopyText={act.onCopyText}
        onDownload={act.onDownload && (() => act.onDownload!([entry]))}
        onRename={() => onRename(entry)}
        onMoveTo={() => onMoveTo([entry])}
        onDelete={() => act.onDelete([entry])}
        onChanged={act.onChanged}
        folderSize={act.folderSize}
        onCalcSize={act.onCalcSize}
        onOpenExternal={onOpenExternal}
        onCopyFile={onCopyFile}
        onPermissions={act.onPermissions && (() => act.onPermissions!([entry]))}
        onShowOriginal={act.onShowOriginal && (() => act.onShowOriginal!(entry))}
        onEdit={act.onEdit && ((at) => act.onEdit!(entry, at))}
      />
    </div>
  );
}

/** A folder: its art, name and size (worked out on request); Open in the header goes in. */
function FolderLook({ entry, folderSize, onCalcSize }: SizeProps & { entry: Entry }) {
  return (
    <div className="ql-none ql-folder">
      <FileIcon entry={entry} size={72} big />
      <strong>{entry.name}</strong>
      <span className="dim">
        <FolderSizeLine entryKey={entry.key} folderSize={folderSize} onCalcSize={onCalcSize} />
        {entry.modified ? ` · ${formatDateFull(entry.modified)}` : ""}
      </span>
    </div>
  );
}

/** Several items at once: a tile each (the photo's thumbnail once one was made), to pick one from. */
function GroupSheet({ profileId, bucket, group, onPick }: { profileId: string; bucket: string; group: Entry[]; onPick: (e: Entry) => void }) {
  const shown = group.slice(0, SHEET_MAX);
  return (
    <div className="ql-sheet">
      {shown.map((e) => (
        <SheetTile key={e.key} profileId={profileId} bucket={bucket} entry={e} onPick={onPick} />
      ))}
      {group.length > shown.length && <div className="ql-tile more">and {(group.length - shown.length).toLocaleString()} more</div>}
    </div>
  );
}

function SheetTile({ profileId, bucket, entry, onPick }: { profileId: string; bucket: string; entry: Entry; onPick: (e: Entry) => void }) {
  const thumbable = canThumb(entry);
  const [thumb, setThumb] = useState<string | null | undefined>(() => (thumbable ? cachedThumb(profileId, bucket, entry) : null));
  useEffect(() => {
    if (!thumbable || thumb !== undefined) return;
    let live = true;
    loadThumb(profileId, bucket, entry, () => live).then((u) => live && setThumb(u ?? null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, bucket, entry.key, thumbable]);
  return (
    <button type="button" className="ql-tile" onClick={() => onPick(entry)} title={`${entry.name}: show it on its own`}>
      <span className="ql-tile-art">{thumb ? <img src={thumb} alt="" /> : <FileIcon entry={entry} size={40} big />}</span>
      <span className="ql-tile-name">{entry.name}</span>
      <span className="ql-tile-sub">{entry.kind === "file" ? entrySize(entry) : "Folder"}</span>
    </button>
  );
}

function Content({ profileId, bucket, entry, onOpen }: { profileId: string; bucket: string; entry: Entry; onOpen: (e: Entry) => void }) {
  const cls = entry.kind === "folder" ? "folder" : classify(entry.name);
  const media = (cls === "image" && isWebImage(entry.name)) || cls === "video" || cls === "audio";
  // Word, Excel, slides, CSV, Markdown, code… and Google Docs / Sheets / Slides (by their export)
  const docAs = entry.kind === "folder" ? null : entry.native ? asExport(entry) : entry;
  const viewer = docAs ? viewerFor(docAs.name, docAs.mime ?? null, docAs.size) : null;
  const doc = !!viewer && viewer.kind !== "image";
  // HEIC, RAW and the like: the thumbnail the grid makes (the original can't be drawn here)
  const thumbable = cls === "image" && !isWebImage(entry.name) && canThumb(entry);
  const [thumb, setThumb] = useState<string | null | undefined>(() => (thumbable ? cachedThumb(profileId, bucket, entry) : null));
  // the photo's blurry placeholder while the image loads
  const placeholder = usePlaceholder(profileId, bucket, cls === "image" ? entry : null);
  const text = cls === "text" && !doc && entry.size <= MAX_TEXT;
  const pdf = cls === "pdf" && entry.size <= MAX_PDF_BYTES;
  const [url, setUrl] = useState<string | null>(null);
  const [body, setBody] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // documents and PDFs read the file as soon as their viewer mounts: hold the viewer back for the
  // same short delay, so arrowing through a folder of them doesn't start a download per file
  // (Content is keyed by the file, so this starts over for each one)
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSettled(true), 120);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    let live = true;
    let revoke: (() => void) | undefined;
    // a short delay, so holding an arrow key doesn't start a download for every file it passes
    const t = setTimeout(() => {
      if (media && cls === "image")
        // through the file cache, so Open / Copy / Download afterwards don't fetch it again
        imageUrl(profileId, bucket, entry)
          .then((r) => {
            if (live) {
              revoke = r.revoke;
              setUrl(r.url);
            } else r.revoke?.();
          })
          .catch((e) => live && setError(errMessage(e)));
      else if (media)
        playableUrl(profileId, bucket, entry)
          .then((u) => live && setUrl(u))
          .catch((e) => live && setError(errMessage(e)));
      else if (text)
        api
          .textPreview(profileId, bucket, entry.key, 1024 * 1024)
          .then((b) => live && setBody(b))
          .catch((e) => live && setError(errMessage(e)));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
      // after the <img> lets go of it (releaseOnUnmount runs on a timer too)
      if (revoke) setTimeout(revoke, 0);
    };
  }, [profileId, bucket, entry.key, media, text]);

  // a thumbnail (the grid's) finishing while the full size is still on its way: show it then
  const [, setThumbTick] = useState(0);
  useEffect(() => {
    if (!media || cls !== "image" || url) return;
    return onThumbReady(profileId, bucket, entry, () => setThumbTick((n) => n + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, bucket, entry.key, media, cls, !!url]);

  useEffect(() => {
    if (!thumbable || thumb !== undefined) return;
    let live = true;
    loadThumb(profileId, bucket, entry, () => live).then((u) => live && setThumb(u ?? null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, bucket, entry.key, thumbable]);

  if (error)
    return (
      <div className="ql-none">
        <Icon name="alert" size={26} />
        <p>Couldn’t show this file.</p>
        <ErrorText message={error} />
      </div>
    );
  if ((pdf || doc) && !settled)
    return (
      <div className="ql-none">
        <span className="spinner" />
      </div>
    );
  if (pdf) return <PdfView profileId={profileId} bucket={bucket} objectKey={entry.key} onError={setError} />;
  if (doc)
    return (
      <Suspense fallback={<div className="ql-none"><span className="spinner" /></div>}>
        <LazyDocumentView key={entry.key} profileId={profileId} bucket={bucket} entry={entry} mode="preview" onOpenFull={onOpen} />
      </Suspense>
    );
  if (thumbable && thumb) return <img className="ql-image thumb" src={thumb} alt={entry.name} />;
  // the thumbnail the grid already made: shown at once, scaled to fit, while
  // the full-size photo comes in (rather than a blur and a wait for something already on screen)
  const ready = media && cls === "image" && !url ? cachedThumb(profileId, bucket, entry) : undefined;
  if (typeof ready === "string")
    return (
      <>
        <img className="ql-image" src={ready} alt={entry.name} />
        <span className="load-badge" role="status">
          <span className="spinner" /> Loading {formatBytes(entry.size)}…
        </span>
      </>
    );
  if (((thumbable && thumb === undefined) || (media && cls === "image" && !url)) && placeholder)
    return (
      <>
        <img className="ql-image ph" src={placeholder} alt="" />
        {/* the blur alone reads as a bad photo: say the real one is on its way */}
        <span className="load-badge" role="status">
          <span className="spinner" /> {thumbable ? "Loading preview…" : `Loading ${formatBytes(entry.size)}…`}
        </span>
      </>
    );
  if (thumbable && thumb === undefined)
    return (
      <div className="ql-none">
        <span className="spinner" />
      </div>
    );
  if (media && !url)
    return (
      <div className="ql-none">
        <span className="spinner" />
      </div>
    );
  if (cls === "image" && url)
    return (
      <img
        ref={releaseOnUnmount}
        className="ql-image"
        src={url}
        alt={entry.name}
        // bytes the web view can't decode (a misnamed file): stream it as before instead
        onError={() => url.startsWith("blob:") && playableUrl(profileId, bucket, entry).then(setUrl, (e) => setError(errMessage(e)))}
      />
    );
  if (cls === "video" && url) return <video ref={releaseOnUnmount} className="ql-video" src={url} controls autoPlay />;
  if (cls === "audio" && url)
    return (
      <div className="ql-none">
        <FileIcon entry={entry} size={64} big />
        <audio ref={releaseOnUnmount} src={url} controls autoPlay />
      </div>
    );
  if (text)
    return body ? (
      <pre className="ql-text">
        {body.text}
        {body.truncated ? "\n\n…" : ""}
      </pre>
    ) : (
      <div className="ql-none">
        <span className="spinner" />
      </div>
    );
  return (
    <div className="ql-none">
      <FileIcon entry={entry} size={72} big />
      <strong>{entry.name}</strong>
      <span className="dim">
        {entry.kind === "folder" ? "Folder" : `${entryKind(entry)} · ${entrySize(entry)}`}
        {entry.modified ? ` · ${formatDateFull(entry.modified)}` : ""}
      </span>
      {entry.kind === "file" && (
        <button className="btn" onClick={() => onOpen(entry)}>
          <Icon name="reveal" size={14} /> Open in its app
        </button>
      )}
    </div>
  );
}
