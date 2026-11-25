/**
 * "Import connections": pick the app to import from (the ones found on this computer first, or
 * a file), then tick the sites to bring over. Every source shares the same list: grouped by the
 * app's folders, searchable, sites already in Kybl and ones Kybl can't open left unticked.
 *
 * Passwords never reach this page: the preview only says whether one is saved, and importing
 * sends the chosen ids back for the backend to read the file again (see importApi.ts).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { errMessage } from "../../core/api";
import { Icon } from "../../ui/components/Icons";
import { Modal } from "../../ui/components/Dialogs";
import { ErrorText } from "../../ui/components/ErrorText";
import { ProviderBadge } from "../../sidebar/Sidebar";
import type { Profile } from "../../core/types";
import { importApi, SOURCE_LOOK, type ImportOutcome, type ImportPreview, type ImportSite, type ImportSource } from "../lib/importApi";
import "./connections.css";

type Props = {
  onClose: () => void;
  /** after importing: the new connections, for the sidebar */
  onImported: (profiles: Profile[]) => void;
  toast: (kind: "info" | "error" | "success", text: string) => void;
};

/** Ticked to begin with: everything Kybl can open that isn't in Kybl already. */
const startsTicked = (s: ImportSite) => !s.skip && !s.duplicateOf;

function SourceBadge({ id }: { id: string }) {
  const look = SOURCE_LOOK[id] ?? { mono: id.slice(0, 2).toUpperCase(), color: "#7c8494" };
  return (
    <span className="pbadge lg" style={{ "--pc": look.color } as React.CSSProperties} aria-hidden="true">
      {look.mono}
    </span>
  );
}

import { plural } from "../../core/format";

export function ImportDialog({ onClose, onImported, toast }: Props) {
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [source, setSource] = useState<ImportSource | null>(null);
  // null: the app's own file
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportOutcome | null>(null);

  useEffect(() => {
    importApi
      .sources()
      .then((list) => setSources([...list].sort((a, b) => Number(b.detected) - Number(a.detected))))
      .catch((e) => setError(errMessage(e)));
  }, []);

  const load = async (src: ImportSource, file: string | null) => {
    setSource(src);
    setPath(file);
    setPreview(null);
    setError(null);
    setLoading(true);
    try {
      setPreview(await importApi.preview(src.id, file));
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const chooseFile = async (src: ImportSource) => {
    const dir = src.path ? src.path.replace(/[\\/][^\\/]*$/, "") : undefined;
    const picked = await openDialog({
      title: `Choose a ${src.name} file`,
      defaultPath: dir,
      // a file with no extension to filter by (~/.ssh/config) can be any file
      filters: src.extensions.length ? [{ name: src.filterName, extensions: src.extensions }] : undefined,
    }).catch(() => null);
    const file = Array.isArray(picked) ? picked[0] : picked;
    if (typeof file === "string") void load(src, file);
  };

  const finish = (out: ImportOutcome) => {
    if (out.imported.length) onImported(out.imported);
    const n = out.imported.length;
    const skipped = out.skipped.length;
    toast(
      n ? "success" : "error",
      n ? `Imported ${plural(n, "connection")}${skipped ? `, ${skipped} skipped` : ""}` : `Nothing imported${skipped ? `: ${plural(skipped, "site")} skipped` : ""}`,
    );
    // the details are worth a look when something didn't come over whole; otherwise just close
    if (skipped || out.needsSecret.length) setResult(out);
    else onClose();
  };

  const runImport = async (ids: string[]) => {
    if (!source) return;
    setBusy(true);
    try {
      finish(await importApi.apply(source.id, path, ids));
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Modal title="Import finished" onClose={onClose} width={480}>
        <div className="modal-body imp-result">
          <p>
            <strong>Imported {plural(result.imported.length, "connection")}</strong>
            {result.skipped.length ? `, ${result.skipped.length} skipped.` : "."}
          </p>
          {result.needsSecret.length > 0 && (
            <>
              <h3>Add a password or key before connecting</h3>
              <ul>
                {result.needsSecret.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </>
          )}
          {result.skipped.length > 0 && (
            <>
              <h3>Skipped</h3>
              <ul>
                {result.skipped.map((s, i) => (
                  <li key={i}>
                    {s.name} <em>{s.reason}</em>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-primary" onClick={onClose} data-autofocus>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  if (!source) {
    return (
      <Modal title="Import connections" onClose={onClose} width={500} help="import">
        <div className="modal-body imp-sources">
          <p>Bring the sites you saved in another app into Kybl. Passwords go straight into Kybl's encrypted vault.</p>
          {!sources && !error && <p className="hint">Looking for apps…</p>}
          {error && (
            <p className="hint error" role="alert">
              <ErrorText message={error} />
            </p>
          )}
          {sources?.map((s) => (
            <div key={s.id} className="imp-source">
              <button type="button" className="kind-tile" onClick={() => (s.detected ? void load(s, null) : void chooseFile(s))}>
                <SourceBadge id={s.id} />
                <span className="kind-text">
                  <strong>{s.name}</strong>
                  <em>{s.detected ? "Found on this computer" : "Not found here: choose its file"}</em>
                </span>
                <Icon name="chevron" size={14} />
              </button>
              {s.detected && (
                <button type="button" className="link-btn" onClick={() => void chooseFile(s)}>
                  Choose file…
                </button>
              )}
            </div>
          ))}
          {sources && <p className="hint">More apps are on the way. A file exported from one of these works too.</p>}
        </div>
      </Modal>
    );
  }

  return (
    // an import under way finishes here: closing now would lose what still needs a password
    <Modal title={`Import from ${source.name}`} onClose={onClose} locked={busy} width={640} help="import">
      {loading ? (
        <div className="modal-body">
          <p className="hint">Reading {source.name}'s sites…</p>
        </div>
      ) : preview ? (
        <SiteList
          key={preview.path}
          preview={preview}
          busy={busy}
          error={error}
          onBack={() => {
            setSource(null);
            setPreview(null);
            setError(null);
          }}
          onChangeFile={() => void chooseFile(source)}
          onImport={(ids) => void runImport(ids)}
          onCancel={onClose}
        />
      ) : (
        <>
          <div className="modal-body">
            <p className="hint error" role="alert">
              <ErrorText message={error ?? "Couldn't read the file."} />
            </p>
          </div>
          <div className="modal-foot split">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setSource(null);
                setError(null);
              }}
            >
              Back
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void chooseFile(source)}>
              Choose file…
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

type Group = { key: string; label: string; sites: ImportSite[] };

/** "Select all" and folder boxes tick these: importable and not already in Kybl */
const bulkPickable = (s: ImportSite) => !s.skip && !s.duplicateOf;

function SiteList({
  preview,
  busy,
  error,
  onBack,
  onChangeFile,
  onImport,
  onCancel,
}: {
  preview: ImportPreview;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onChangeFile: () => void;
  onImport: (ids: string[]) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(preview.sites.filter(startsTicked).map((s) => s.id)));
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () => (q ? preview.sites.filter((s) => [s.name, s.host, s.user, s.protocol, ...s.folder].some((t) => t.toLowerCase().includes(q))) : preview.sites),
    [preview.sites, q],
  );
  // folders in the order the app lists them; sites outside any folder come first, unlabelled
  const groups = useMemo(() => {
    const by = new Map<string, Group>();
    for (const s of visible) {
      const key = s.folder.join("\u0000");
      let g = by.get(key);
      if (!g) by.set(key, (g = { key, label: s.folder.join(" / "), sites: [] }));
      g.sites.push(s);
    }
    return [...by.values()].sort((a, b) => Number(!!a.key) - Number(!!b.key));
  }, [visible]);

  // bulk ticking leaves out sites already in Kybl (they can still be ticked one by one); unticking takes all
  const setMany = (list: ImportSite[], on: boolean) =>
    setPicked((cur) => {
      const next = new Set(cur);
      for (const s of list) if (!s.skip) on ? bulkPickable(s) && next.add(s.id) : next.delete(s.id);
      return next;
    });
  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const count = picked.size;
  const dupes = preview.sites.filter((s) => s.duplicateOf).length;
  const unsupported = preview.sites.filter((s) => s.skip).length;

  return (
    <>
      <div className="modal-body imp-body">
        <div className="imp-file">
          <span className="mono" title={preview.path}>
            <bdi>{preview.path}</bdi>
          </span>
          <button type="button" className="link-btn" onClick={onChangeFile} disabled={busy}>
            Other file…
          </button>
        </div>
        {preview.hints.map((h) => (
          <p key={h} className="hint">
            {h}
          </p>
        ))}
        {preview.sites.length === 0 ? (
          <p className="hint">This file has no saved sites.</p>
        ) : (
          <>
            <div className="imp-tools">
              <label className="imp-search">
                <Icon name="search" size={13} />
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name, server or folder" aria-label="Filter sites" />
              </label>
              <button type="button" className="link-btn" onClick={() => setMany(visible, true)}>
                Select all
              </button>
              <button type="button" className="link-btn" onClick={() => setMany(visible, false)}>
                Select none
              </button>
            </div>
            <div className="imp-list" role="group" aria-label="Sites to import">
              {groups.length === 0 && <p className="hint">No site matches “{query}”.</p>}
              {groups.map((g) => (
                <section key={g.key} className="imp-group">
                  {g.key && <FolderHead group={g} picked={picked} onSet={(on) => setMany(g.sites, on)} />}
                  {g.sites.map((s) => (
                    <SiteRow key={s.id} site={s} on={picked.has(s.id)} onToggle={() => toggle(s.id)} />
                  ))}
                </section>
              ))}
            </div>
          </>
        )}
        {error && (
          <p className="hint error" role="alert">
            <ErrorText message={error} />
          </p>
        )}
      </div>
      <div className="modal-foot split">
        <button type="button" className="btn" onClick={onBack} disabled={busy}>
          Back
        </button>
        <span className="imp-sum">
          {[dupes && `${dupes} already in Kybl`, unsupported && `${unsupported} not supported`].filter(Boolean).join(" · ")}
        </span>
        <div className="btn-row">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!count || busy} onClick={() => onImport(preview.sites.filter((s) => picked.has(s.id)).map((s) => s.id))}>
            {busy ? "Importing…" : count ? `Import ${plural(count, "connection")}` : "Import"}
          </button>
        </div>
      </div>
    </>
  );
}

function FolderHead({ group, picked, onSet }: { group: Group; picked: Set<string>; onSet: (on: boolean) => void }) {
  const can = group.sites.filter(bulkPickable);
  const n = can.filter((s) => picked.has(s.id)).length;
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = n > 0 && n < can.length;
  }, [n, can.length]);
  return (
    <label className="imp-folder">
      <input ref={box} type="checkbox" checked={can.length > 0 && n === can.length} disabled={!can.length} onChange={(e) => onSet(e.target.checked)} />
      <Icon name="folder" size={14} />
      <span className="imp-folder-name">{group.label}</span>
      <span className="imp-count">{group.sites.length}</span>
    </label>
  );
}

function SiteRow({ site: s, on, onToggle }: { site: ImportSite; on: boolean; onToggle: () => void }) {
  const where = s.host ? `${s.user ? `${s.user}@` : ""}${s.host}${s.port ? `:${s.port}` : ""}${s.startDir ? ` ${s.startDir}` : ""}` : "";
  return (
    <label className={`imp-site${s.skip ? " off" : ""}`}>
      <input type="checkbox" checked={on && !s.skip} disabled={!!s.skip} onChange={onToggle} />
      {s.kind ? (
        <ProviderBadge provider={s.kind} />
      ) : (
        <span className="pbadge" aria-hidden="true">
          –
        </span>
      )}
      <span className="imp-site-text">
        <span className="imp-site-top">
          <strong>{s.name || s.host}</strong>
          <span className="pill">{s.protocol}</span>
          {s.duplicateOf && (
            <span className="pill accent" title={`Matches “${s.duplicateOf}”`}>
              Already in Kybl
            </span>
          )}
        </span>
        {where && <span className="imp-where mono">{where}</span>}
        {s.skip ? (
          <span className="imp-note">{s.skip}</span>
        ) : (
          s.notes.length > 0 && <span className={`imp-note${s.needsSecret ? " warn" : ""}`}>{s.notes.join(" · ")}</span>
        )}
      </span>
    </label>
  );
}
