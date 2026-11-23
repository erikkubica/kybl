/**
 * What there is to know about one file or folder, and what can be done with it: its name, the
 * actions (download or open, copy to the clipboard, move or copy, rename, delete), a share link,
 * size, date, kind and place, the technical details (headers, key, ETag, metadata, tags) and the
 * properties editor. Also the summary of a selection of several items.
 *
 * Shown under the preview on phones (PreviewPane) and in Quick Look's info column on desktop
 * (desktop/QuickLook, "Get Info").
 */
import { useEffect, useState } from "react";
import { api, errMessage } from "../api";
import { Icon } from "../Icons";
import { formatBytes, formatDateFull, entrySize, entryKind } from "../format";
import { FileIcon } from "./FileIcon";
import { ErrorText } from "./ErrorText";
import { PropsEditor } from "./PropsEditor";
import { storageClassLabel } from "./storageClasses";
import type { FolderSizeInfo } from "./listNav";
import { EXPIRIES } from "../settings";
import type { Entry, ObjectDetails } from "../types";
import { useCaps } from "../useCaps";
import { rootName } from "../connections/roots";
import { useLocalCopy } from "../localCopyProgress";
import { ServerProps } from "../perms/ServerProps";

/** A details request for a key that no longer exists (deleted or moved elsewhere). */
export const isNotFound = (msg: string) => /NotFound|NoSuchKey|status: 404|\b404\b/i.test(msg);

export type SizeProps = {
  folderSize?(key: string): FolderSizeInfo | undefined;
  onCalcSize?(key: string): void;
};

/**
 * The object's own details (headers, metadata), read once per file. `gone`: the file isn't there
 * any more, which replaces the preview with a note.
 */
export function useObjectHead(profileId: string, bucket: string, entry: Entry) {
  const isFolder = entry.kind === "folder";
  const [details, setDetails] = useState<ObjectDetails | null>(null);
  // why the details couldn't be read; a missing file replaces the whole preview
  const [headError, setHeadError] = useState<string | null>(null);
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
  return { details, setDetails, headError, gone: !!headError && isNotFound(headError) };
}

export type ObjectHead = ReturnType<typeof useObjectHead>;

/** Folder size line: the total once known, live progress while it adds up, else a button. */
export function FolderSizeLine({ entryKey, folderSize, onCalcSize }: SizeProps & { entryKey: string }) {
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

export type EntryInfoProps = SizeProps & {
  profileId: string;
  bucket: string;
  entry: Entry;
  head: ObjectHead;
  /** share-link lifetime preselected from Settings, in seconds */
  defaultExpiry: number;
  /** the lifetime picked, when the caller keeps it (from one file to the next in Quick Look) */
  expiry?: number;
  onExpiry?(secs: number): void;
  onCopyLink: (secs: number) => void;
  onCopyText: (text: string, what: string) => void;
  /** absent on this computer's own disk: there is nothing to download */
  onDownload?: () => void;
  onRename: () => void;
  onMoveTo: () => void;
  onDelete: () => void;
  /** properties or tags were saved (or the file turned out to be gone): reload the list */
  onChanged?(): void;
  /** on this computer's own disk, "Open" in its app takes Download's place */
  onOpenExternal?(e: Entry): void;
  /** the file itself on the clipboard, to paste into a chat or a folder (macOS) */
  onCopyFile?(e: Entry): void;
  /** servers: "Permissions…" and a link's "Show original" (src/perms) */
  onPermissions?(): void;
  onShowOriginal?(): void;
  /**
   * "pane": under a preview, the first action is the big one (phones). "sheet": a column beside
   * Quick Look's preview, which has Open in its own header, so the actions are all plain buttons
   * and the name comes with the item's icon.
   */
  variant?: "pane" | "sheet";
};

/** One file or folder: its name, actions, share link, properties and technical details. */
export function EntryInfo({
  profileId,
  bucket,
  entry,
  head,
  defaultExpiry,
  expiry: keptExpiry,
  onExpiry,
  onCopyLink,
  onCopyText,
  onDownload,
  onRename,
  onMoveTo,
  onDelete,
  onChanged,
  folderSize,
  onCalcSize,
  onOpenExternal,
  onCopyFile,
  onPermissions,
  onShowOriginal,
  variant = "pane",
}: EntryInfoProps) {
  const isFolder = entry.kind === "folder";
  const sheet = variant === "sheet";
  const { details, setDetails, headError, gone } = head;
  // a Copy or Open of this file still downloading shows on its button
  const busy = useLocalCopy(profileId, bucket, entry.key);
  const [ownExpiry, setOwnExpiry] = useState(defaultExpiry);
  useEffect(() => setOwnExpiry(defaultExpiry), [defaultExpiry]);
  const expiry = keptExpiry ?? ownExpiry;
  const setExpiry = onExpiry ?? setOwnExpiry;
  const [editing, setEditing] = useState(false);
  // null = not loaded yet; providers without tagging just list none
  const [tags, setTags] = useState<Record<string, string> | null>(null);
  // what the connection can't do is left out (no share links on this device's own folders, say);
  // while its answer loads, S3's usual actions show
  const caps = useCaps(profileId);
  const canShare = caps?.share !== "none";
  const canProps = !caps || caps.metadata === "s3";
  const canTags = !caps || caps.tags;

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
  const sub = (
    <p className="preview-sub">
      {entryKind(entry)}
      {!isFolder && ` · ${entrySize(entry)}`}
    </p>
  );

  return (
    <>
      {sheet ? (
        <div className="ei-head">
          <FileIcon entry={entry} size={30} />
          <div className="ei-name">
            <h3 className="preview-title selectable" title={entry.name}>
              {entry.name}
            </h3>
            {sub}
          </div>
        </div>
      ) : (
        <>
          <h3 className="preview-title selectable" title={entry.name}>
            {entry.name}
          </h3>
          {sub}
        </>
      )}

      {sheet && gone && (
        <div className="result bad ei-gone">
          <Icon name="alert" size={15} />
          <span>
            This file was deleted or moved.{" "}
            {onChanged && (
              <button type="button" className="link-btn" onClick={onChanged}>
                Refresh the list
              </button>
            )}
          </span>
        </div>
      )}

      <div className="preview-actions">
        {onDownload ? (
          <button className={`btn grow ${sheet ? "" : "btn-primary"}`} onClick={onDownload}>
            <Icon name="download" size={15} /> Download
          </button>
        ) : (
          // already on this computer: open it in its app instead (Quick Look has its own Open)
          !sheet &&
          onOpenExternal &&
          !isFolder && (
            <button className="btn btn-primary grow" onClick={() => onOpenExternal(entry)} disabled={!!busy}>
              <Icon name="external" size={15} /> {busy?.verb === "open" ? `Opening ${busy.percent}%` : "Open"}
            </button>
          )
        )}
        {onCopyFile && !isFolder && !gone && (
          <button
            className={`btn ${busy?.verb === "copy" ? "btn-progress" : ""}`}
            style={busy?.verb === "copy" ? ({ "--p": `${busy.percent}%` } as React.CSSProperties) : undefined}
            onClick={() => onCopyFile(entry)}
            disabled={!!busy}
            title={busy?.verb === "copy" ? `Copying… ${busy.percent}%` : "Copy the file, to paste into a chat, a mail or a folder"}
            aria-label="Copy file to clipboard"
          >
            {busy?.verb === "copy" ? <span className="btn-pct">{busy.percent}%</span> : <Icon name="copy" size={15} />}
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
            <ServerProps entry={entry} onPermissions={caps?.permissions ? onPermissions : undefined} onShowOriginal={caps?.links ? onShowOriginal : undefined} />
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
    </>
  );
}

/** Several items: how many of what, their total size, and what can be done with all of them. */
export function SelectionInfo({
  selection,
  folderSize,
  onCalcSize,
  onDownload,
  onMoveTo,
  onDelete,
}: SizeProps & {
  selection: Entry[];
  onDownload?: () => void;
  onMoveTo: () => void;
  onDelete: () => void;
}) {
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
        <button type="button" className="link-btn" onClick={() => selection.forEach((e) => e.kind === "folder" && !folderSize?.(e.key) && onCalcSize(e.key))}>
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
