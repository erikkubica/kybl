import { Suspense, useEffect, useState } from "react";
import { api, errMessage } from "../api";
import { Icon } from "../Icons";
import { classify, formatDateFull, isWebImage, entrySize, entryKind } from "../format";
import { FileIcon } from "../components/FileIcon";
import { ErrorText } from "../components/ErrorText";
import { MAX_PDF_BYTES, PdfView } from "../components/PdfView";
import type { Entry } from "../types";
import { imageUrl, playableUrl } from "../media";
import { cachedThumb, canThumb, loadThumb } from "../thumbs";
import { usePlaceholder } from "../thumbhash";
import { asExport } from "../connections/native";
// the same previews as the details panel (components/PreviewPane): documents in the document
// viewer, images the web view can't draw by their thumbnail, Google files by their Office export
import { LazyDocumentView, viewerFor } from "../viewers/registry";
import { releaseOnUnmount } from "../releaseMedia";
import { useLocalCopy } from "../localCopyProgress";

const MAX_TEXT = 50 * 1000 * 1000;

/**
 * Space bar preview, like Quick Look in Finder: a large look at the selected file over the list.
 * Arrow keys page through the files around it, Space or Escape closes it, Enter or ⌘O opens the
 * file in its default app.
 */
export function QuickLook({
  profileId,
  bucket,
  entry,
  index,
  count,
  onStep,
  onClose,
  onOpen,
  onDownload,
  onCopyFile,
}: {
  profileId: string;
  bucket: string;
  entry: Entry;
  /** position among the list's entries, for "3 of 40" */
  index: number;
  count: number;
  onStep: (delta: number) => void;
  onClose: () => void;
  onOpen: (e: Entry) => void;
  /** absent on this computer's own disk */
  onDownload?: (e: Entry) => void;
  /** the file itself on the clipboard (⌘C here), to paste into a chat or a folder */
  onCopyFile?: (e: Entry) => void;
}) {
  // a Copy or Open of this file still downloading shows on its button
  const busy = useLocalCopy(profileId, bucket, entry.key);
  const working = !!busy;
  // the list underneath must not see these keys while the preview is up
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      let handled = true;
      if (e.key === "Escape" || e.key === " ") onClose();
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") onStep(-1);
      else if (e.key === "ArrowRight" || e.key === "ArrowDown") onStep(1);
      else if (e.key === "Enter" || (mod && e.key.toLowerCase() === "o")) onOpen(entry);
      else if (mod && (e.key.toLowerCase() === "w" || e.key === ".")) onClose();
      else if (mod && e.key.toLowerCase() === "c" && onCopyFile && entry.kind === "file" && !window.getSelection()?.toString()) {
        if (!working) onCopyFile(entry);
      }
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [entry, onClose, onStep, onOpen, onCopyFile, working]);

  return (
    <div className="ql-backdrop" onMouseDown={onClose}>
      <div className="ql" role="dialog" aria-modal="true" aria-label={`Preview of ${entry.name}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="ql-head">
          <button className="icon-btn" onClick={() => onStep(-1)} disabled={index <= 0} aria-label="Previous" title="Previous (←)">
            <Icon name="chevron" size={14} className="ql-prev" />
          </button>
          <button className="icon-btn" onClick={() => onStep(1)} disabled={index >= count - 1} aria-label="Next" title="Next (→)">
            <Icon name="chevron" size={14} />
          </button>
          <div className="ql-title">
            <strong title={entry.key}>{entry.name}</strong>
            <span>
              {entry.kind === "file" ? `${entrySize(entry)} · ` : ""}
              {entryKind(entry)}
              {count > 1 ? ` · ${index + 1} of ${count.toLocaleString()}` : ""}
            </span>
          </div>
          {entry.kind === "file" && (
            <>
              {onCopyFile && (
                <button
                  className={`btn btn-sm ${busy?.verb === "copy" ? "btn-progress" : ""}`}
                  style={busy?.verb === "copy" ? ({ "--p": `${busy.percent}%` } as React.CSSProperties) : undefined}
                  onClick={() => onCopyFile(entry)}
                  disabled={!!busy}
                  title="Copy the file, to paste into a chat, a mail or a folder (⌘C)"
                >
                  <Icon name="copy" size={14} /> {busy?.verb === "copy" ? `Copying ${busy.percent}%` : "Copy"}
                </button>
              )}
              {onDownload && (
                <button className="btn btn-sm" onClick={() => onDownload(entry)}>
                  <Icon name="download" size={14} /> Download
                </button>
              )}
              <button
                className={`btn btn-sm btn-primary ${busy?.verb === "open" ? "btn-progress" : ""}`}
                style={busy?.verb === "open" ? ({ "--p": `${busy.percent}%` } as React.CSSProperties) : undefined}
                onClick={() => onOpen(entry)}
                disabled={!!busy}
                title="Open in its app (⌘O)"
              >
                <Icon name="reveal" size={14} /> {busy?.verb === "open" ? `Opening ${busy.percent}%` : "Open"}
              </button>
            </>
          )}
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Space)">
            <Icon name="x" />
          </button>
        </div>
        <div className="ql-body">
          <Content key={entry.key} profileId={profileId} bucket={bucket} entry={entry} onOpen={onOpen} />
        </div>
      </div>
    </div>
  );
}

function Content({ profileId, bucket, entry, onOpen }: { profileId: string; bucket: string; entry: Entry; onOpen: (e: Entry) => void }) {
  const cls = entry.kind === "folder" ? "folder" : classify(entry.name);
  const media = (cls === "image" && isWebImage(entry.name)) || cls === "video" || cls === "audio";
  // Word, Excel, slides, CSV, Markdown, code… and Google Docs / Sheets / Slides (by their export)
  const docAs = entry.kind === "folder" ? null : entry.native ? asExport(entry) : entry;
  const viewer = docAs ? viewerFor(docAs.name, null, docAs.size) : null;
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
  if (pdf) return <PdfView profileId={profileId} bucket={bucket} objectKey={entry.key} onError={setError} />;
  if (doc)
    return (
      <Suspense fallback={<div className="ql-none"><span className="spinner" /></div>}>
        <LazyDocumentView key={entry.key} profileId={profileId} bucket={bucket} entry={entry} mode="preview" onOpenFull={onOpen} />
      </Suspense>
    );
  if (thumbable && thumb) return <img className="ql-image thumb" src={thumb} alt={entry.name} />;
  if (((thumbable && thumb === undefined) || (media && cls === "image" && !url)) && placeholder)
    return <img className="ql-image ph" src={placeholder} alt="" />;
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
