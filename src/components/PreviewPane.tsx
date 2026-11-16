import { useEffect, useState } from "react";
import { api, errMessage } from "../api";
import { Icon } from "../Icons";
import { classify, extOf, formatBytes, formatDateFull, isWebImage, kindLabel } from "../format";
import { cachedThumb, canThumb, loadThumb } from "../thumbs";
import { FileIcon } from "./FileIcon";
import { MAX_PDF_BYTES, PdfView } from "./PdfView";
import { EXPIRIES } from "../settings";
import type { Entry, ObjectDetails } from "../types";

const BIG_IMAGE = 25 * 1000 * 1000;

/** The webview's own right-click menu (Reload, Inspect…) means nothing here; keep it for selected text. */
const quiet = (ev: React.MouseEvent) => {
  if (!window.getSelection()?.toString()) ev.preventDefault();
};

export function PreviewPane({
  profileId,
  bucket,
  selection,
  defaultExpiry,
  onCopyLink,
  onCopyText,
  onDownload,
  onRename,
  onMoveTo,
  onDelete,
  onContext,
}: {
  profileId: string;
  bucket: string;
  selection: Entry[];
  /** share-link lifetime preselected from Settings, in seconds */
  defaultExpiry: number;
  onCopyLink: (secs: number) => void;
  onCopyText: (text: string, what: string) => void;
  onDownload: () => void;
  onRename: () => void;
  onMoveTo: () => void;
  onDelete: () => void;
  /** right-click on the preview: the app's own menu for this item */
  onContext: (ev: React.MouseEvent, e: Entry) => void;
}) {
  const [expiry, setExpiry] = useState(defaultExpiry);
  useEffect(() => setExpiry(defaultExpiry), [defaultExpiry]);

  if (selection.length === 0) {
    return (
      <aside className="preview" onContextMenu={quiet}>
        <div className="preview-empty">
          <div className="empty-art">
            <Icon name="eye" size={24} />
          </div>
          <h3>Nothing selected</h3>
          <p>Select a file to preview it and see its details.</p>
        </div>
      </aside>
    );
  }

  if (selection.length > 1) {
    const total = selection.reduce((s, e) => s + (e.kind === "file" ? e.size : 0), 0);
    return (
      <aside className="preview" onContextMenu={quiet}>
        <div className="preview-empty">
          <div className="empty-art">
            <Icon name="copy" size={24} />
          </div>
          <h3>{selection.length} items selected</h3>
          <p>{formatBytes(total)} in files{selection.some((e) => e.kind === "folder") ? " (folders not counted)" : ""}</p>
          <div className="preview-actions col">
            <button className="btn" onClick={onDownload}>
              <Icon name="download" size={15} /> Download
            </button>
            <button className="btn" onClick={onMoveTo}>
              <Icon name="move" size={15} /> Move to…
            </button>
            <button className="btn btn-danger-ghost" onClick={onDelete}>
              <Icon name="trash" size={15} /> Delete
            </button>
          </div>
        </div>
      </aside>
    );
  }

  const entry = selection[0];
  return (
    <aside className="preview" onContextMenu={quiet}>
      <FileDetails
        key={entry.key}
        profileId={profileId}
        bucket={bucket}
        entry={entry}
        expiry={expiry}
        setExpiry={setExpiry}
        onCopyLink={onCopyLink}
        onCopyText={onCopyText}
        onDownload={onDownload}
        onRename={onRename}
        onMoveTo={onMoveTo}
        onDelete={onDelete}
        onContext={onContext}
      />
    </aside>
  );
}

function FileDetails({
  profileId,
  bucket,
  entry,
  expiry,
  setExpiry,
  onCopyLink,
  onCopyText,
  onDownload,
  onRename,
  onMoveTo,
  onDelete,
  onContext,
}: {
  profileId: string;
  bucket: string;
  entry: Entry;
  expiry: number;
  setExpiry: (n: number) => void;
  onCopyLink: (secs: number) => void;
  onCopyText: (text: string, what: string) => void;
  onDownload: () => void;
  onRename: () => void;
  onMoveTo: () => void;
  onDelete: () => void;
  onContext: (ev: React.MouseEvent, e: Entry) => void;
}) {
  const isFolder = entry.kind === "folder";
  const cls = classify(entry.name);
  const [details, setDetails] = useState<ObjectDetails | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forceLoad, setForceLoad] = useState(false);

  // Images show the small cached thumbnail (the same one the grid uses) instead of downloading
  // the original; "Full size" fetches the real file on demand. null = no thumbnail could be made.
  const thumbable = !isFolder && cls === "image" && canThumb(entry);
  const [thumb, setThumb] = useState<string | null | undefined>(() => (thumbable ? cachedThumb(profileId, bucket, entry) : null));
  const useThumb = thumbable && !forceLoad && thumb !== null;
  const gated = !forceLoad && cls === "image" && (useThumb || entry.size > BIG_IMAGE);
  const pdfTooBig = cls === "pdf" && entry.size > MAX_PDF_BYTES;
  // PDFs are drawn by the app (PdfView) and need no link; everything else streams from a signed URL
  const previewable = !isFolder && ((cls === "image" && isWebImage(entry.name)) || cls === "video" || cls === "audio");
  const showsPdf = !isFolder && cls === "pdf" && !pdfTooBig;

  useEffect(() => {
    if (isFolder) return;
    let live = true;
    api
      .headObject(profileId, bucket, entry.key)
      .then((d) => live && setDetails(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [profileId, bucket, entry.key, isFolder]);

  useEffect(() => {
    if (!thumbable || thumb !== undefined) return;
    let live = true;
    loadThumb(profileId, bucket, entry, () => live).then((u) => live && setThumb(u ?? null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, bucket, entry.key, thumbable]);

  useEffect(() => {
    if (isFolder) return;
    let live = true;
    const timer = setTimeout(() => {
      if (previewable && !gated) {
        api
          .presign(profileId, bucket, entry.key, 3600)
          .then((u) => live && setUrl(u))
          .catch((e) => live && setError(errMessage(e)));
      } else if (cls === "text" && entry.size <= 50 * 1000 * 1000) {
        api
          .textPreview(profileId, bucket, entry.key)
          .then((t) => live && setText(t))
          .catch((e) => live && setError(errMessage(e)));
      }
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [profileId, bucket, entry.key, entry.size, cls, previewable, gated, isFolder]);

  const s3Uri = `s3://${bucket}/${entry.key}`;
  // "Photos / 2026" instead of a raw key; the full key lives under Technical details
  const folderPath = entry.key.slice(0, entry.key.length - entry.name.length - (isFolder ? 1 : 0)).replace(/\/$/, "");
  const where = [bucket, ...folderPath.split("/").filter(Boolean)].join(" › ");
  const [techOpen, setTechOpen] = useState(() => {
    try {
      return localStorage.getItem("s3b.techDetails") === "1";
    } catch {
      return false;
    }
  });
  const toggleTech = () => {
    setTechOpen((v) => {
      try {
        localStorage.setItem("s3b.techDetails", v ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !v;
    });
  };
  const etag = details?.etag ?? entry.etag;
  const storageClass = details?.storageClass ?? entry.storageClass;
  const loadingMedia = !error && !gated && ((previewable && !url) || (cls === "text" && !text));
  const unsupported = !isFolder && !error && !previewable && !showsPdf && cls !== "text" && !useThumb;
  const showsImage = !isFolder && !error && !!url && cls === "image";

  return (
    <div className="preview-inner">
      <div
        className={`preview-media ${showsPdf ? "pdf" : ""} ${showsImage && !["jpg", "jpeg"].includes(extOf(entry.name)) ? "" : "plain"}`}
        onContextMenu={(ev) => {
          // text previews keep the native menu (Copy, and on phones the long-press selection)
          if ((ev.target as HTMLElement).closest(".text-preview")) return;
          ev.preventDefault();
          onContext(ev, entry);
        }}
      >
        {!isFolder && !error && useThumb && thumb && (
          <>
            <img src={thumb} alt={entry.name} />
            {isWebImage(entry.name) && (
              <button className="btn btn-sm media-action" onClick={() => setForceLoad(true)} title={`Load the original (${formatBytes(entry.size)})`}>
                Full size
              </button>
            )}
          </>
        )}
        {!isFolder && !error && useThumb && thumb === undefined && (
          <div className="preview-note">
            <span className="spinner" />
          </div>
        )}
        {isFolder && (
          <div className="preview-note">
            <FileIcon entry={entry} size={64} />
          </div>
        )}
        {!isFolder && error && (
          <div className="preview-note">
            <Icon name="alert" size={22} />
            <p>{error}</p>
          </div>
        )}
        {!isFolder && !error && gated && !useThumb && (
          <div className="preview-note">
            <FileIcon entry={entry} size={44} />
            <p>This image is {formatBytes(entry.size)}.</p>
            <button className="btn btn-sm" onClick={() => setForceLoad(true)}>
              Load preview
            </button>
          </div>
        )}
        {showsImage && <img src={url!} alt={entry.name} onError={() => setError("Could not load image")} />}
        {!error && url && cls === "video" && <video src={url} controls preload="metadata" />}
        {!error && url && cls === "audio" && <audio src={url} controls preload="metadata" />}
        {showsPdf && !error && <PdfView profileId={profileId} bucket={bucket} objectKey={entry.key} onError={setError} />}
        {!error && text && (
          <pre className="text-preview">
            {text.text}
            {text.truncated && "\n… (truncated)"}
          </pre>
        )}
        {unsupported && (
          <div className="preview-note">
            <FileIcon entry={entry} size={56} />
            <p>{pdfTooBig ? `This PDF is ${formatBytes(entry.size)}, too large to preview here.` : "No preview for this file type"}</p>
          </div>
        )}
        {!isFolder && loadingMedia && (
          <div className="preview-note">
            <span className="spinner" />
          </div>
        )}
      </div>

      <h3 className="preview-title selectable" title={entry.name}>
        {entry.name}
      </h3>
      <p className="preview-sub">
        {kindLabel(entry.name, isFolder)}
        {!isFolder && ` · ${formatBytes(entry.size)}`}
      </p>

      <div className="preview-actions">
        <button className="btn btn-primary grow" onClick={onDownload}>
          <Icon name="download" size={15} /> Download
        </button>
        <button className="btn" onClick={onMoveTo} title="Move or copy to…" aria-label="Move or copy to another folder">
          <Icon name="move" size={15} />
        </button>
        <button className="btn" onClick={onRename} title="Rename" aria-label="Rename">
          <Icon name="edit" size={15} />
        </button>
        <button className="btn btn-danger-ghost" onClick={onDelete} title="Delete" aria-label="Delete">
          <Icon name="trash" size={15} />
        </button>
      </div>

      {!isFolder && (
        <div className="section">
          <div className="section-title">Share link</div>
          <div className="share-row">
            <div className="seg" role="group" aria-label="Link expiry">
              {EXPIRIES.map((x) => (
                <button key={x.secs} className={expiry === x.secs ? "on" : ""} aria-pressed={expiry === x.secs} onClick={() => setExpiry(x.secs)}>
                  {x.label}
                </button>
              ))}
            </div>
            <button className="btn btn-sm" onClick={() => onCopyLink(expiry)}>
              <Icon name="link" size={14} /> Copy
            </button>
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-title">About this {isFolder ? "folder" : "file"}</div>
        <dl className="props">
          {!isFolder && <Prop label="Size">{formatBytes(entry.size)}</Prop>}
          {(details?.modified ?? entry.modified) && <Prop label="Modified">{formatDateFull(details?.modified ?? entry.modified)}</Prop>}
          <Prop label="Kind">{kindLabel(entry.name, isFolder)}</Prop>
          <Prop label="Location">{where}</Prop>
        </dl>

        <button className="disclose" aria-expanded={techOpen} onClick={toggleTech}>
          <Icon name="chevron" size={11} className="disclose-caret" />
          Technical details
        </button>
        {techOpen && (
          <dl className="props tech">
            {!isFolder && <Prop label="Exact size">{entry.size.toLocaleString()} bytes</Prop>}
            {details?.contentType && <Prop label="Content type">{details.contentType}</Prop>}
            {storageClass && <Prop label="Storage class">{storageClass}</Prop>}
            <Prop label="Object key" mono onCopy={() => onCopyText(entry.key, "Object key")}>
              {entry.key}
            </Prop>
            <Prop label="S3 URI" mono onCopy={() => onCopyText(s3Uri, "S3 URI")}>
              {s3Uri}
            </Prop>
            {etag && (
              <Prop label="ETag" mono onCopy={() => onCopyText(etag.replace(/"/g, ""), "ETag")}>
                {etag.replace(/"/g, "")}
              </Prop>
            )}
            {details &&
              Object.entries(details.metadata).map(([k, v]) => (
                <Prop key={k} label={k} mono onCopy={() => onCopyText(v, k)}>
                  {v}
                </Prop>
              ))}
          </dl>
        )}
      </div>
    </div>
  );
}

/** One label/value line. With `onCopy` the whole line is a click-to-copy target. */
function Prop({ label, mono, onCopy, children }: { label: string; mono?: boolean; onCopy?: () => void; children: React.ReactNode }) {
  return (
    <div className={`prop ${onCopy ? "copyable" : ""}`} onClick={onCopy} title={onCopy ? "Click to copy" : undefined}>
      <dt title={label}>{label}</dt>
      <dd className={mono ? "mono" : ""}>{children}</dd>
      {onCopy && <Icon name="copy" size={12} className="copy-hint" />}
    </div>
  );
}
