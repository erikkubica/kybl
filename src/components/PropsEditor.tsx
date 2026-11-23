/**
 * Edit an object's headers (Content-Type, Cache-Control, …), storage class, user metadata and
 * tags from the file info (Get Info, the phone's details screen). Headers and metadata are saved by copying the object onto itself
 * (api.updateObjectProps); tags have their own call and are left out when the provider has no
 * tagging.
 */
import { useEffect, useId, useState } from "react";
import { api, errMessage, type ObjectProps } from "../api";
import { Icon } from "../Icons";
import { extOf } from "../format";
import { ErrorText } from "./ErrorText";
import { STORAGE_CLASSES } from "./storageClasses";
import type { ObjectDetails } from "../types";

/** Content types people actually set, with the file's own likely type first. */
const COMMON_TYPES = [
  "application/octet-stream",
  "application/json",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/javascript",
  "application/xml",
  "application/wasm",
  "text/plain; charset=utf-8",
  "text/html; charset=utf-8",
  "text/css; charset=utf-8",
  "text/csv; charset=utf-8",
  "text/markdown; charset=utf-8",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "font/woff2",
];
const BY_EXT: Record<string, string> = {
  json: "application/json",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  js: "application/javascript",
  mjs: "application/javascript",
  xml: "application/xml",
  wasm: "application/wasm",
  txt: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  woff2: "font/woff2",
};
const CACHE_HINTS = ["no-cache", "no-store", "max-age=300", "max-age=3600", "max-age=86400", "public, max-age=31536000, immutable"];
const ENCODINGS = ["gzip", "br", "zstd", "identity"];
const COLD = new Set(["GLACIER", "DEEP_ARCHIVE"]);
const MAX_TAGS = 10;

type Row = { id: number; k: string; v: string };
let rowSeq = 0;
const rows = (o: Record<string, string>): Row[] => Object.entries(o).map(([k, v]) => ({ id: ++rowSeq, k, v }));
const toRecord = (list: Row[]) => Object.fromEntries(list.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]));
const same = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k]);
};

/** Tagging that the provider doesn't offer: the tags block is left out instead of showing an error. */
export function tagsUnsupported(msg: string): boolean {
  return /NotImplemented|not implemented|Unsupported|not supported|MethodNotAllowed|status: 501|status: 405/i.test(msg);
}

/** Metadata keys travel as HTTP headers (x-amz-meta-…): letters, digits, "-" and "_" only. */
const KEY_OK = /^[A-Za-z0-9_-]+$/;
// eslint-disable-next-line no-control-regex
const ASCII = /^[\x20-\x7e]*$/;

function rowErrors(list: Row[], kind: "meta" | "tag"): Map<number, string> {
  const out = new Map<number, string>();
  const seen = new Set<string>();
  for (const r of list) {
    const k = r.k.trim();
    if (!k) {
      if (r.v) out.set(r.id, "Add a name for this value.");
      continue;
    }
    const norm = kind === "meta" ? k.toLowerCase() : k;
    if (seen.has(norm)) out.set(r.id, "This name is used twice.");
    seen.add(norm);
    if (kind === "meta") {
      if (!KEY_OK.test(k)) out.set(r.id, "Names can use letters, digits, - and _ only.");
      else if (!ASCII.test(r.v)) out.set(r.id, "Values must be plain ASCII text (no accents or emoji).");
    } else {
      if (k.length > 128) out.set(r.id, "Tag names can be up to 128 characters.");
      else if (r.v.length > 256) out.set(r.id, "Tag values can be up to 256 characters.");
    }
  }
  return out;
}

function Rows({
  label,
  list,
  setList,
  errors,
  max,
  keyHint,
  addLabel,
}: {
  label: string;
  list: Row[];
  setList: (r: Row[]) => void;
  errors: Map<number, string>;
  max?: number;
  keyHint: string;
  addLabel: string;
}) {
  return (
    <fieldset className="pe-rows">
      <legend>{label}</legend>
      {list.length === 0 && <p className="pe-none">None</p>}
      {list.map((r, i) => {
        const err = errors.get(r.id);
        return (
          <div key={r.id} className="pe-row-wrap">
            <div className={`pe-row ${err ? "bad" : ""}`}>
              <input
                aria-label={`${label} name ${i + 1}`}
                placeholder={keyHint}
                value={r.k}
                aria-invalid={!!err}
                onChange={(e) => setList(list.map((x) => (x.id === r.id ? { ...x, k: e.target.value } : x)))}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
              />
              <input
                aria-label={`${label} value ${i + 1}`}
                placeholder="Value"
                value={r.v}
                aria-invalid={!!err}
                onChange={(e) => setList(list.map((x) => (x.id === r.id ? { ...x, v: e.target.value } : x)))}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
              />
              <button type="button" className="icon-btn" aria-label={`Remove ${r.k || "this row"}`} title="Remove" onClick={() => setList(list.filter((x) => x.id !== r.id))}>
                <Icon name="x" size={13} />
              </button>
            </div>
            {err && <p className="pe-err">{err}</p>}
          </div>
        );
      })}
      <button
        type="button"
        className="btn btn-sm btn-ghost pe-add"
        disabled={max !== undefined && list.length >= max}
        onClick={() => setList([...list, { id: ++rowSeq, k: "", v: "" }])}
      >
        <Icon name="plus" size={13} /> {addLabel}
      </button>
      {max !== undefined && list.length >= max && <p className="pe-hint">Up to {max} tags per file.</p>}
    </fieldset>
  );
}

export function PropsEditor({
  profileId,
  bucket,
  objectKey,
  name,
  details,
  onSaved,
  onHeadersSaved,
  onCancel,
}: {
  profileId: string;
  bucket: string;
  objectKey: string;
  name: string;
  details: ObjectDetails;
  onSaved: (d: ObjectDetails) => void;
  /** the headers saved but the tags did not: show the new headers, keep the form open */
  onHeadersSaved?: (d: ObjectDetails) => void;
  onCancel: () => void;
}) {
  const uid = useId();
  const [contentType, setContentType] = useState(details.contentType ?? "");
  const [cacheControl, setCacheControl] = useState(details.cacheControl ?? "");
  const [disposition, setDisposition] = useState(details.contentDisposition ?? "");
  const [encoding, setEncoding] = useState(details.contentEncoding ?? "");
  const startClass = details.storageClass || "STANDARD";
  const known = STORAGE_CLASSES.some((s) => s.id === startClass);
  const [storageClass, setStorageClass] = useState(startClass);
  const [customClass, setCustomClass] = useState(!known);
  const [meta, setMeta] = useState<Row[]>(() => rows(details.metadata ?? {}));
  // tags: null while loading; `tagsState` says whether the provider has them at all
  const [tags, setTags] = useState<Row[] | null>(null);
  const [origTags, setOrigTags] = useState<Record<string, string>>({});
  const [tagsState, setTagsState] = useState<"loading" | "ok" | "unsupported" | "error">("loading");
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .objectTags(profileId, bucket, objectKey)
      .then((t) => {
        if (!live) return;
        setOrigTags(t);
        setTags(rows(t));
        setTagsState("ok");
      })
      .catch((e) => {
        if (!live) return;
        const msg = errMessage(e);
        setTagsState(tagsUnsupported(msg) ? "unsupported" : "error");
        setTagsError(msg);
      });
    return () => {
      live = false;
    };
  }, [profileId, bucket, objectKey]);

  const metaErrors = rowErrors(meta, "meta");
  const tagErrors = rowErrors(tags ?? [], "tag");
  const typeError = contentType.trim() && !/^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/.test(contentType.trim()) ? "Use the form type/subtype, like image/png." : null;
  const classError = customClass && !/^[A-Z0-9_]*$/.test(storageClass.trim()) ? "Storage classes are written in capitals, like STANDARD." : null;
  const invalid = metaErrors.size > 0 || tagErrors.size > 0 || !!typeError || !!classError;

  const guess = BY_EXT[extOf(name)];
  const typeOptions = guess ? [guess, ...COMMON_TYPES.filter((t) => t !== guess)] : COMMON_TYPES;

  const norm = (s: string) => s.trim() || null;
  const props: ObjectProps = {};
  if (norm(contentType) !== (details.contentType ?? null)) props.contentType = norm(contentType);
  if (norm(cacheControl) !== (details.cacheControl ?? null)) props.cacheControl = norm(cacheControl);
  if (norm(disposition) !== (details.contentDisposition ?? null)) props.contentDisposition = norm(disposition);
  if (norm(encoding) !== (details.contentEncoding ?? null)) props.contentEncoding = norm(encoding);
  const cls = storageClass.trim() || "STANDARD";
  if (cls !== startClass) props.storageClass = cls;
  const nextMeta = toRecord(meta);
  if (!same(nextMeta, details.metadata ?? {})) props.metadata = nextMeta;
  const nextTags = tags ? toRecord(tags) : origTags;
  const tagsChanged = tagsState === "ok" && !same(nextTags, origTags);
  const headersChanged = Object.keys(props).length > 0;
  const dirty = headersChanged || tagsChanged;

  const save = async () => {
    if (invalid || !dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      let d = details;
      if (headersChanged) d = await api.updateObjectProps(profileId, bucket, objectKey, props);
      if (tagsChanged) {
        try {
          await api.setObjectTags(profileId, bucket, objectKey, nextTags);
        } catch (e) {
          // the headers did save: show them (the new baseline), keep the form open for the tags
          if (headersChanged) onHeadersSaved?.(d);
          throw new Error(`The properties were saved, but the tags were not.\n\n${errMessage(e)}`);
        }
      }
      onSaved(d);
    } catch (e) {
      setError(errMessage(e));
      setSaving(false);
    }
  };

  return (
    <form
      className="props-editor"
      aria-label="Edit properties"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !saving) {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <label className="field">
        <span>Content type</span>
        <input
          list={`${uid}-types`}
          value={contentType}
          onChange={(e) => setContentType(e.target.value)}
          placeholder={guess ?? "application/octet-stream"}
          aria-invalid={!!typeError}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoFocus={!window.matchMedia?.("(pointer: coarse)").matches}
        />
        <datalist id={`${uid}-types`}>
          {typeOptions.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        {typeError ? <em className="pe-err">{typeError}</em> : <em className="pe-hint">How browsers and apps open the file.</em>}
      </label>

      <label className="field">
        <span>Cache-Control</span>
        <input list={`${uid}-cache`} value={cacheControl} onChange={(e) => setCacheControl(e.target.value)} placeholder="Not set" spellCheck={false} autoCorrect="off" autoCapitalize="off" />
        <datalist id={`${uid}-cache`}>
          {CACHE_HINTS.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <em className="pe-hint">How long browsers and CDNs may keep a copy.</em>
      </label>

      <label className="field">
        <span>Content-Disposition</span>
        <input list={`${uid}-disp`} value={disposition} onChange={(e) => setDisposition(e.target.value)} placeholder="Not set" spellCheck={false} autoCorrect="off" autoCapitalize="off" />
        <datalist id={`${uid}-disp`}>
          <option value="inline" />
          <option value={`attachment; filename="${name.replace(/"/g, "")}"`} />
        </datalist>
        <em className="pe-hint">“inline” shows it in the browser, “attachment” downloads it.</em>
      </label>

      <label className="field">
        <span>Content-Encoding</span>
        <input list={`${uid}-enc`} value={encoding} onChange={(e) => setEncoding(e.target.value)} placeholder="Not set" spellCheck={false} autoCorrect="off" autoCapitalize="off" />
        <datalist id={`${uid}-enc`}>
          {ENCODINGS.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <em className="pe-hint">Only set this if the stored bytes really are compressed.</em>
      </label>

      <div className="field">
        <span id={`${uid}-class`}>Storage class</span>
        <select
          aria-labelledby={`${uid}-class`}
          value={customClass ? "__custom" : storageClass}
          onChange={(e) => {
            if (e.target.value === "__custom") {
              setCustomClass(true);
              setStorageClass("");
            } else {
              setCustomClass(false);
              setStorageClass(e.target.value);
            }
          }}
        >
          {STORAGE_CLASSES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
          <option value="__custom">Other…</option>
        </select>
        {customClass && (
          <input
            className="mono"
            aria-label="Storage class name"
            value={storageClass}
            onChange={(e) => setStorageClass(e.target.value.toUpperCase())}
            placeholder="e.g. COLD"
            aria-invalid={!!classError}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="characters"
          />
        )}
        {classError ? (
          <em className="pe-err">{classError}</em>
        ) : COLD.has(cls) && cls !== startClass ? (
          <em className="pe-warn">Files in this class must be restored before they can be downloaded or previewed again.</em>
        ) : (
          <em className="pe-hint">Providers differ: many only offer Standard.</em>
        )}
      </div>

      <Rows label="Metadata" list={meta} setList={setMeta} errors={metaErrors} keyHint="name" addLabel="Add metadata" />

      {tagsState === "ok" && tags && <Rows label="Tags" list={tags} setList={setTags} errors={tagErrors} max={MAX_TAGS} keyHint="Tag" addLabel="Add tag" />}
      {tagsState === "loading" && (
        <p className="pe-hint pe-loading">
          <span className="spinner sm" /> Loading tags…
        </p>
      )}
      {tagsState === "error" && tagsError && (
        <div className="pe-rows">
          <p className="pe-hint">Tags couldn’t be loaded, so they are left as they are.</p>
          <ErrorText message={tagsError} />
        </div>
      )}

      {error && (
        <div className="result bad">
          <Icon name="alert" size={15} />
          <ErrorText message={error} />
        </div>
      )}

      {headersChanged && <p className="pe-hint">Saving rewrites the file in place with the new properties; its modified date changes.</p>}
      <div className="pe-foot">
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={!dirty || invalid || saving}>
          {saving && <span className="spinner sm" />}
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
