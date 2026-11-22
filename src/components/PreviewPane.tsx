import { Suspense, useEffect, useState } from "react";
import { api, errMessage } from "../api";
import { Icon } from "../Icons";
import { classify, extOf, formatBytes, formatDateFull, isWebImage, entrySize, entryKind } from "../format";
import { cachedThumb, canThumb, loadThumb } from "../thumbs";
import { imageUrl, playableUrl } from "../media";
import { FileIcon } from "./FileIcon";
import { MAX_PDF_BYTES, PdfView } from "./PdfView";
import { ErrorText } from "./ErrorText";
import { PropsEditor } from "./PropsEditor";
import { storageClassLabel } from "./storageClasses";
import type { FolderSizeInfo } from "./listNav";
import { EXPIRIES } from "../settings";
import type { Entry, ObjectDetails } from "../types";
import { useCaps } from "../useCaps";
import { rootName } from "../connections/roots";
import { asExport } from "../connections/native";
// data and import() calls only: the viewers themselves load on first use (see viewers/INTEGRATION.md)
import { LazyDocumentView, viewerFor } from "../viewers/registry";
import { releaseOnUnmount } from "../releaseMedia";

const BIG_IMAGE = 25 * 1000 * 1000;

/** The webview's own right-click menu (Reload, Inspect…) means nothing here; keep it for selected text. */
const quiet = (ev: React.MouseEvent) => {
  if (!window.getSelection()?.toString()) ev.preventDefault();
};

/** A details request for a key that no longer exists (deleted or moved elsewhere). */
const isNotFound = (msg: string) => /NotFound|NoSuchKey|status: 404|\b404\b/i.test(msg);

type SizeProps = {
  folderSize?(key: string): FolderSizeInfo | undefined;
  onCalcSize?(key: string): void;
};

type DocProps = {
  /** documents: "Open" in the full document view (editing where it can) */
  onOpenFull?(e: Entry): void;
  /** documents: "Open in another app" (download to the temporary folder, then open it) */
  onOpenExternal?(e: Entry): void;
  /** the file itself on the clipboard, to paste into a chat or a folder (macOS) */
  onCopyFile?(e: Entry): void;
};

/** Folder size line: the total once known, live progress while it adds up, else a button. */
function FolderSizeLine({ entryKey, folderSize, onCalcSize }: SizeProps & { entryKey: string }) {
  const info = folderSize?.(entryKey);
  if (info?.running)
    return (
      <span className="fsize-line" role="status">
        <span className="spinner sm" /> Adding up… {formatBytes(info.bytes)} in {info.objects.toLocaleString()} {info.objects === 1 ? "object" : "objects"} so far
      </span>
    );
  if (info)
    return (
      <span>
        {formatBytes(info.bytes)} · {info.objects.toLocaleString()} {info.objects === 1 ? "object" : "objects"}
      </span>
    );
  if (!onCalcSize) return <span className="faint">Not known</span>;
  return (
    <button type="button" className="link-btn" onClick={() => onCalcSize(entryKey)} title="Lists everything in the folder to add it up: one request per 1,000 objects">
      Calculate size
    </button>
  );
}

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
  onChanged,
  folderSize,
  onCalcSize,
  onOpenFull,
  onOpenExternal,
  onCopyFile,
}: SizeProps & DocProps & {
  profileId: string;
  bucket: string;
  selection: Entry[];
  /** share-link lifetime preselected from Settings, in seconds */
  defaultExpiry: number;
  onCopyLink: (secs: number) => void;
  onCopyText: (text: string, what: string) => void;
  /** absent on this computer's own disk: there is nothing to download */
  onDownload?: () => void;
  onRename: () => void;
  onMoveTo: () => void;
  onDelete: () => void;
  /** right-click on the preview: the app's own menu for this item */
  onContext: (ev: React.MouseEvent, e: Entry) => void;
  /** properties or tags were saved (or the file turned out to be gone): reload the list */
  onChanged?(): void;
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
    // folders count once their size is known (worked out from the menu or the Size column)
    let total = 0;
    let files = 0;
    let unknown = 0;
    for (const e of selection) {
      if (e.kind === "file") {
        total += e.size;
        files++;
        continue;
      }
      const fs = folderSize?.(e.key);
      if (fs && !fs.running) total += fs.bytes;
      else unknown++;
    }
    const folders = selection.length - files;
    const parts = [files && `${files.toLocaleString()} ${files === 1 ? "file" : "files"}`, folders && `${folders.toLocaleString()} ${folders === 1 ? "folder" : "folders"}`].filter(Boolean);
    const running = selection.some((e) => e.kind === "folder" && folderSize?.(e.key)?.running);
    return (
      <aside className="preview" onContextMenu={quiet}>
        <div className="preview-empty">
          <div className="empty-art">
            <Icon name="copy" size={24} />
          </div>
          <h3>{selection.length.toLocaleString()} items selected</h3>
          <p>{parts.join(" and ")}</p>
          <p className="preview-total">
            {running && <span className="spinner sm" />} {formatBytes(total)}
            {unknown > 0 && !running && (
              <>
                {" "}
                <span className="faint">(not counting {unknown === 1 ? "1 folder" : `${unknown.toLocaleString()} folders`})</span>
              </>
            )}
          </p>
          {unknown > 0 && !running && onCalcSize && (
            <button
              type="button"
              className="link-btn"
              onClick={() => selection.forEach((e) => e.kind === "folder" && !folderSize?.(e.key) && onCalcSize(e.key))}
            >
              Add up the {unknown === 1 ? "folder" : "folders"} too
            </button>
          )}
          <div className="preview-actions col">
            {onDownload && (
              <button className="btn" onClick={onDownload}>
                <Icon name="download" size={15} /> Download
              </button>
            )}
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
        onChanged={onChanged}
        folderSize={folderSize}
        onCalcSize={onCalcSize}
        onOpenFull={onOpenFull}
        onOpenExternal={onOpenExternal}
        onCopyFile={onCopyFile}
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
  onChanged,
  folderSize,
  onCalcSize,
  onOpenFull,
  onOpenExternal,
  onCopyFile,
}: SizeProps & DocProps & {
  profileId: string;
  bucket: string;
  entry: Entry;
  expiry: number;
  setExpiry: (n: number) => void;
  onCopyLink: (secs: number) => void;
  onCopyText: (text: string, what: string) => void;
  /** absent on this computer's own disk: there is nothing to download */
  onDownload?: () => void;
  onRename: () => void;
  onMoveTo: () => void;
  onDelete: () => void;
  onContext: (ev: React.MouseEvent, e: Entry) => void;
  onChanged?(): void;
}) {
  const isFolder = entry.kind === "folder";
  const cls = classify(entry.name);
  const [details, setDetails] = useState<ObjectDetails | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forceLoad, setForceLoad] = useState(false);
  // why the details couldn't be read; a missing file replaces the whole preview
  const [headError, setHeadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // null = not loaded yet; providers without tagging just list none
  const [tags, setTags] = useState<Record<string, string> | null>(null);
  const gone = !!headError && isNotFound(headError);
  // what the connection can't do is left out (no share links on this device's own folders, say);
  // while its answer loads, S3's usual actions show
  const caps = useCaps(profileId);
  const canShare = caps?.share !== "none";
  const canProps = !caps || caps.metadata === "s3";
  const canTags = !caps || caps.tags;
  // text, code, JSON, Markdown, CSV, Word, Excel and slides show in the document viewer; images
  // keep the thumbnail flow below (cheaper than downloading the original)
  // (a Google Doc / Sheet / Slides by its Office export, which DocumentView shows)
  const docAs = entry.native ? asExport(entry) : entry;
  const viewer = isFolder || !docAs ? null : viewerFor(docAs.name, entry.native ? null : details?.contentType, docAs.size);
  const showsDoc = !!viewer && viewer.kind !== "image";

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
    setHeadError(null);
    api
      .headObject(profileId, bucket, entry.key)
      .then((d) => live && setDetails(d))
      .catch((e) => live && setHeadError(errMessage(e)));
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
    let revoke: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (gone) return;
      if (previewable && !gated && cls === "image") {
        // through the file cache, so Open / Copy / Download afterwards don't fetch it again
        imageUrl(profileId, bucket, entry, caps)
          .then((r) => {
            if (live) {
              revoke = r.revoke;
              setUrl(r.url);
            } else r.revoke?.();
          })
          .catch((e) => live && setError(errMessage(e)));
      } else if (previewable && !gated) {
        // presigned on S3; through the app where the connection can't presign
        playableUrl(profileId, bucket, entry, caps)
          .then((u) => live && setUrl(u))
          .catch((e) => live && setError(errMessage(e)));
      } else if (cls === "text" && !showsDoc && entry.size <= 50 * 1000 * 1000) {
        api
          .textPreview(profileId, bucket, entry.key)
          .then((t) => live && setText(t))
          .catch((e) => live && setError(errMessage(e)));
      }
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
      if (revoke) setTimeout(revoke, 0);
    };
  }, [profileId, bucket, entry.key, entry.size, cls, previewable, gated, isFolder, gone, showsDoc]);

  const s3Uri = `s3://${bucket}/${entry.key}`;
  // "Photos / 2026" instead of a raw key; the full key lives under Technical details
  const folderPath = entry.key.slice(0, entry.key.length - entry.name.length - (isFolder ? 1 : 0)).replace(/\/$/, "");
  const where = [rootName(profileId, bucket), ...folderPath.split("/").filter(Boolean)].join(" › ");
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
  // tags show under Technical details, fetched the first time that is open
  useEffect(() => {
    if (isFolder || !techOpen || tags !== null || gone || !canTags) return;
    let live = true;
    api
      .objectTags(profileId, bucket, entry.key)
      .then((t) => live && setTags(t))
      .catch(() => live && setTags({}));
    return () => {
      live = false;
    };
  }, [profileId, bucket, entry.key, isFolder, techOpen, tags, gone, canTags]);

  const etag = details?.etag ?? entry.etag;
  const storageClass = details?.storageClass ?? entry.storageClass;
  const loadingMedia = !gone && !error && !gated && ((previewable && !url) || (cls === "text" && !showsDoc && !text));
  const unsupported = !gone && !isFolder && !error && !previewable && !showsPdf && !showsDoc && cls !== "text" && !useThumb;
  const showsImage = !isFolder && !error && !!url && cls === "image";

  return (
    <div className="preview-inner">
      <div
        className={`preview-media ${showsPdf ? "pdf" : ""} ${showsDoc && !gone ? "doc" : ""} ${showsImage && !["jpg", "jpeg"].includes(extOf(entry.name)) ? "" : "plain"}`}
        onContextMenu={(ev) => {
          // text previews keep the native menu (Copy, and on phones the long-press selection)
          if ((ev.target as HTMLElement).closest(".text-preview, .dv")) return;
          ev.preventDefault();
          onContext(ev, entry);
        }}
      >
        {gone && (
          <div className="preview-note gone">
            <Icon name="alert" size={22} />
            <p>
              <strong>This file was deleted or moved</strong>
              <br />
              It’s no longer at this place in the bucket.
            </p>
            {onChanged && (
              <button className="btn btn-sm" onClick={onChanged}>
                <Icon name="refresh" size={13} /> Refresh the list
              </button>
            )}
          </div>
        )}
        {!gone && !isFolder && !error && useThumb && thumb && (
          <>
            <img src={thumb} alt={entry.name} />
            {isWebImage(entry.name) && (
              <button className="btn btn-sm media-action" onClick={() => setForceLoad(true)} title={`Load the original (${formatBytes(entry.size)})`}>
                Full size
              </button>
            )}
          </>
        )}
        {!gone && !isFolder && !error && useThumb && thumb === undefined && (
          <div className="preview-note">
            <span className="spinner" />
          </div>
        )}
        {isFolder && (
          <div className="preview-note">
            <FileIcon entry={entry} size={64} />
          </div>
        )}
        {!gone && !isFolder && error && (
          <div className="preview-note">
            <Icon name="alert" size={22} />
            <p>{error}</p>
          </div>
        )}
        {!gone && !isFolder && !error && gated && !useThumb && (
          <div className="preview-note">
            <FileIcon entry={entry} size={44} />
            <p>This image is {formatBytes(entry.size)}.</p>
            <button className="btn btn-sm" onClick={() => setForceLoad(true)}>
              Load preview
            </button>
          </div>
        )}
        {showsImage && <img
            ref={releaseOnUnmount}
            src={url!}
            alt={entry.name}
            // bytes the web view can't decode (a misnamed file): stream it as before, then give up
            onError={() =>
              url?.startsWith("blob:")
                ? playableUrl(profileId, bucket, entry, caps).then(setUrl, () => setError("Could not load image"))
                : setError("Could not load image")
            }
          />}
        {!error && url && cls === "video" && <video ref={releaseOnUnmount} src={url} controls preload="metadata" />}
        {!error && url && cls === "audio" && <audio ref={releaseOnUnmount} src={url} controls preload="metadata" />}
        {showsPdf && !error && !gone && <PdfView profileId={profileId} bucket={bucket} objectKey={entry.key} onError={setError} />}
        {showsDoc && !gone && (
          <Suspense
            fallback={
              <div className="preview-note">
                <span className="spinner" />
              </div>
            }
          >
            <LazyDocumentView key={entry.key} profileId={profileId} bucket={bucket} entry={entry} mode="preview" onOpenFull={onOpenFull} onOpenExternal={onOpenExternal} />
          </Suspense>
        )}
        {!error && text && !showsDoc && (
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
        {entryKind(entry)}
        {!isFolder && ` · ${entrySize(entry)}`}
      </p>

      <div className="preview-actions">
        {onDownload ? (
          <button className="btn btn-primary grow" onClick={onDownload}>
            <Icon name="download" size={15} /> Download
          </button>
        ) : (
          // already on this computer: open it in its app instead
          onOpenExternal &&
          !isFolder && (
            <button className="btn btn-primary grow" onClick={() => onOpenExternal(entry)}>
              <Icon name="external" size={15} /> Open
            </button>
          )
        )}
        {onCopyFile && !isFolder && !gone && (
          <button className="btn" onClick={() => onCopyFile(entry)} title="Copy the file, to paste into a chat, a mail or a folder" aria-label="Copy file to clipboard">
            <Icon name="copy" size={15} />
          </button>
        )}
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

      {!isFolder && !gone && canShare && (
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

      {editing && details ? (
        <div className="section">
          <div className="section-title">Edit properties</div>
          <PropsEditor
            profileId={profileId}
            bucket={bucket}
            objectKey={entry.key}
            name={entry.name}
            details={details}
            onCancel={() => setEditing(false)}
            onSaved={(d) => {
              setDetails(d);
              setTags(null);
              setEditing(false);
              onChanged?.();
            }}
          />
        </div>
      ) : (
      <div className="section">
        <div className="section-title">About this {isFolder ? "folder" : "file"}</div>
        {headError && !gone && (
          <div className="result bad preview-head-error">
            <Icon name="alert" size={15} />
            <span>
              Couldn’t load the latest details. <ErrorText message={headError} />
            </span>
          </div>
        )}
        <dl className="props">
          {!isFolder && <Prop label="Size">{entrySize(entry)}</Prop>}
          {isFolder && (
            <Prop label="Size">
              <FolderSizeLine entryKey={entry.key} folderSize={folderSize} onCalcSize={onCalcSize} />
            </Prop>
          )}
          {(details?.modified ?? entry.modified) && <Prop label="Modified">{formatDateFull(details?.modified ?? entry.modified)}</Prop>}
          <Prop label="Kind">{entryKind(entry)}</Prop>
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
            {details?.cacheControl && <Prop label="Cache-Control">{details.cacheControl}</Prop>}
            {details?.contentDisposition && <Prop label="Disposition">{details.contentDisposition}</Prop>}
            {details?.contentEncoding && <Prop label="Encoding">{details.contentEncoding}</Prop>}
            {storageClass && <Prop label="Storage class">{storageClassLabel(storageClass)}</Prop>}
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
            {tags &&
              Object.entries(tags).map(([k, v]) => (
                <Prop key={`tag:${k}`} label={`Tag: ${k}`} mono onCopy={() => onCopyText(v, k)}>
                  {v}
                </Prop>
              ))}
          </dl>
        )}
        {!isFolder && !gone && canProps && (
          <button className="btn btn-sm props-edit" onClick={() => setEditing(true)} disabled={!details} title={details ? undefined : "Loading the details…"}>
            <Icon name="edit" size={13} /> Edit properties…
          </button>
        )}
      </div>
      )}
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
