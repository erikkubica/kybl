import { useEffect, useState } from "react";
import { api, errMessage } from "../api";
import { Icon } from "../Icons";
import { classify, formatBytes, formatDateFull, isWebImage, kindLabel } from "../format";
import { FileIcon } from "../components/FileIcon";
import { ErrorText } from "../components/ErrorText";
import { MAX_PDF_BYTES, PdfView } from "../components/PdfView";
import type { Entry } from "../types";

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
  onDownload: (e: Entry) => void;
}) {
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
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [entry, onClose, onStep, onOpen]);

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
              {entry.kind === "file" ? `${formatBytes(entry.size)} · ` : ""}
              {kindLabel(entry.name, entry.kind === "folder")}
              {count > 1 ? ` · ${index + 1} of ${count.toLocaleString()}` : ""}
            </span>
          </div>
          {entry.kind === "file" && (
            <>
              <button className="btn btn-sm" onClick={() => onDownload(entry)}>
                <Icon name="download" size={14} /> Download
              </button>
              <button className="btn btn-sm btn-primary" onClick={() => onOpen(entry)} title="Open in its app (⌘O)">
                <Icon name="reveal" size={14} /> Open
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
  const text = cls === "text" && entry.size <= MAX_TEXT;
  const pdf = cls === "pdf" && entry.size <= MAX_PDF_BYTES;
  const [url, setUrl] = useState<string | null>(null);
  const [body, setBody] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // a short delay, so holding an arrow key doesn't start a download for every file it passes
    const t = setTimeout(() => {
      if (media)
        api
          .presign(profileId, bucket, entry.key, 3600)
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
    };
  }, [profileId, bucket, entry.key, media, text]);

  if (error)
    return (
      <div className="ql-none">
        <Icon name="alert" size={26} />
        <p>Couldn’t show this file.</p>
        <ErrorText message={error} />
      </div>
    );
  if (pdf) return <PdfView profileId={profileId} bucket={bucket} objectKey={entry.key} onError={setError} />;
  if (media && !url)
    return (
      <div className="ql-none">
        <span className="spinner" />
      </div>
    );
  if (cls === "image" && url) return <img className="ql-image" src={url} alt={entry.name} />;
  if (cls === "video" && url) return <video className="ql-video" src={url} controls autoPlay />;
  if (cls === "audio" && url)
    return (
      <div className="ql-none">
        <FileIcon entry={entry} size={64} big />
        <audio src={url} controls autoPlay />
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
        {entry.kind === "folder" ? "Folder" : `${kindLabel(entry.name, false)} · ${formatBytes(entry.size)}`}
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
