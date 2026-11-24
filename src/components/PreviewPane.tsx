import { Suspense, useEffect, useState } from "react";
import { api, errMessage } from "../api";
import { Icon } from "../Icons";
import { classify, extOf, formatBytes, isWebImage } from "../format";
import { cachedThumb, canThumb, loadThumb } from "../thumbs";
import { usePlaceholder } from "../thumbhash";
import { hasImage, imageUrl, onImageReady, playableUrl } from "../media";
import { FileIcon } from "./FileIcon";
import { MAX_PDF_BYTES, PdfView } from "./PdfView";
import { EntryInfo, SelectionInfo, useObjectHead, type SizeProps } from "./EntryInfo";
import type { Entry } from "../types";
import { useCaps } from "../useCaps";
import { asExport } from "../connections/native";
// data and import() calls only: the viewers themselves load on first use (see viewers/INTEGRATION.md)
import { LazyDocumentView, viewerFor } from "../viewers/registry";
import { releaseOnUnmount } from "../releaseMedia";

/**
 * The phone's details screen: a preview of the file over what EntryInfo shows about it (desktop
 * shows the same information in Quick Look's info column, "Get Info").
 */

const BIG_IMAGE = 25 * 1000 * 1000;

/** The webview's own right-click menu (Reload, Inspect...) means nothing here; keep it for selected text. */
const quiet = (ev: React.MouseEvent) => {
  if (!window.getSelection()?.toString()) ev.preventDefault();
};

type DocProps = {
  /** documents: "Open" in the full document view (editing where it can) */
  onOpenFull?(e: Entry): void;
  /** documents: "Open in another app" (download to the temporary folder, then open it) */
  onOpenExternal?(e: Entry): void;
  /** the file itself on the clipboard, to paste into a chat or a folder (macOS) */
  onCopyFile?(e: Entry): void;
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
  onChanged,
  folderSize,
  onCalcSize,
  onCancelSize,
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
    return (
      <aside className="preview" onContextMenu={quiet}>
        <SelectionInfo profileId={profileId} selection={selection} folderSize={folderSize} onCalcSize={onCalcSize} onCancelSize={onCancelSize} onDownload={onDownload} onMoveTo={onMoveTo} onDelete={onDelete} />
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
        defaultExpiry={defaultExpiry}
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
        onCancelSize={onCancelSize}
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
  defaultExpiry,
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
  onCancelSize,
  onOpenFull,
  onOpenExternal,
  onCopyFile,
}: SizeProps & DocProps & {
  profileId: string;
  bucket: string;
  entry: Entry;
  defaultExpiry: number;
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
  const head = useObjectHead(profileId, bucket, entry);
  const { details, gone } = head;
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Quick Look already has the full-size photo: show it here too (same bytes, no fetch)
  const [forceLoad, setForceLoad] = useState(() => entry.kind !== "folder" && isWebImage(entry.name) && hasImage(profileId, bucket, entry));
  // streams through the app where the connection can't presign
  const caps = useCaps(profileId);
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

  // …or once it finishes there, if that comes before this panel's own thumbnail
  useEffect(() => {
    if (forceLoad || entry.kind === "folder" || !isWebImage(entry.name)) return;
    return onImageReady(profileId, bucket, entry, () => setForceLoad(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, bucket, entry.key, forceLoad]);

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
      // already loaded for Quick Look: no reason to wait
    }, cls === "image" && hasImage(profileId, bucket, entry) ? 0 : 180);
    return () => {
      live = false;
      clearTimeout(timer);
      if (revoke) setTimeout(revoke, 0);
    };
  }, [profileId, bucket, entry.key, entry.size, cls, previewable, gated, isFolder, gone, showsDoc]);

  const loadingMedia = !gone && !error && !gated && ((previewable && !url) || (cls === "text" && !showsDoc && !text));
  const unsupported = !gone && !isFolder && !error && !previewable && !showsPdf && !showsDoc && cls !== "text" && !useThumb;
  const showsImage = !isFolder && !error && !!url && cls === "image";
  // the photo's blurry placeholder while its thumbnail (or the image itself) loads
  const placeholder = usePlaceholder(profileId, bucket, cls === "image" && !isFolder ? entry : null);
  const imageLoading = !gone && !isFolder && !error && ((useThumb && thumb === undefined) || (cls === "image" && previewable && !gated && !url));

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
              It’s no longer at this place.
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
        {imageLoading && placeholder && (
          <>
            <img className="ph" src={placeholder} alt="" />
            {/* the blur alone reads as a bad photo: say the real one is on its way */}
            <span className="load-badge" role="status">
              <span className="spinner" /> {useThumb ? "Loading preview…" : `Loading ${formatBytes(entry.size)}…`}
            </span>
          </>
        )}
        {!gone && !isFolder && !error && useThumb && thumb === undefined && !placeholder && (
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

      <EntryInfo
        profileId={profileId}
        bucket={bucket}
        entry={entry}
        head={head}
        defaultExpiry={defaultExpiry}
        expiry={expiry}
        onExpiry={setExpiry}
        onCopyLink={onCopyLink}
        onCopyText={onCopyText}
        onDownload={onDownload}
        onRename={onRename}
        onMoveTo={onMoveTo}
        onDelete={onDelete}
        onChanged={onChanged}
        folderSize={folderSize}
        onCalcSize={onCalcSize}
        onCancelSize={onCancelSize}
        onOpenExternal={onOpenExternal}
        onCopyFile={onCopyFile}
      />
    </div>
  );
}
