/**
 * "Upload to…": pick a connection, bucket and folder for files shared into Kybl from another
 * app. The place being looked at (`at`) lives with the caller, so the system back walks up.
 */
import { useEffect, useState } from "react";
import { api, errMessage, errSummary } from "../api";
import { Icon } from "../Icons";
import { FileIcon } from "../components/FileIcon";
import { ProviderBadge } from "../components/Sidebar";
import { baseName, formatBytes } from "../format";
import type { Profile } from "../types";
import type { Loc } from "./useListing";
import { connName } from "./connName";

export type SharedFile = { path: string; name: string; size: number };

export function DestinationScreen({
  files,
  at,
  profiles,
  buckets,
  onAt,
  onPick,
  onBack,
}: {
  files: SharedFile[];
  at: Loc | null;
  profiles: Profile[];
  /** bucket names per connection, as the home screen has them */
  buckets: Record<string, { names: string[]; loading: boolean; note?: string | null }>;
  onAt: (l: Loc | null) => void;
  onPick: (l: Loc) => void;
  onBack: () => void;
}) {
  const [folders, setFolders] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string[]>([]);
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    if (!at) return;
    let live = true;
    setFolders(null);
    setError(null);
    setNaming(false);
    api
      .listObjects(at.profileId, at.bucket, at.prefix)
      .then((r) => live && setFolders(r.folders))
      .catch((e) => live && setError(errSummary(errMessage(e))));
    return () => {
      live = false;
    };
  }, [at]);

  const total = files.reduce((s, f) => s + f.size, 0);
  const what = files.length === 1 ? `“${files[0].name}”` : `${files.length} files`;
  const title = at ? (at.prefix ? baseName(at.prefix) : at.bucket) : "Upload to…";
  const here = at ? [...new Set([...(folders ?? []), ...made.filter((m) => m.startsWith(at.prefix) && !m.slice(at.prefix.length, -1).includes("/"))])] : [];

  return (
    <section className="m-screen m-overlay m-dest">
      <header className="m-bar solid">
        <button className="m-icon" onClick={onBack} aria-label={at ? "Back" : "Cancel"}>
          <Icon name={at ? "arrow-left" : "x"} size={22} />
        </button>
        <div className="m-title">
          <h1>{title}</h1>
          <p>
            Upload {what} · {formatBytes(total)}
          </p>
        </div>
      </header>
      <div className="m-scroll">
        {!at ? (
          profiles.length === 0 ? (
            <div className="m-empty">
              <h3>No connections yet</h3>
              <p>Add a connection first, then share the files to Kybl again.</p>
            </div>
          ) : (
            profiles.map((p) => (
              <section key={p.id} className="m-dest-conn">
                <h2 className="m-section">
                  <ProviderBadge provider={p.provider} /> {connName(p)}
                </h2>
                <ul className="m-group">
                  {buckets[p.id]?.loading && !buckets[p.id]?.names.length && (
                    <li className="m-bucket-note">
                      <span className="spinner" /> Loading buckets…
                    </li>
                  )}
                  {!buckets[p.id]?.loading && !buckets[p.id]?.names.length && (
                    <li className="m-bucket-note">{buckets[p.id]?.note ?? "No buckets here yet."}</li>
                  )}
                  {(buckets[p.id]?.names ?? []).map((b) => (
                    <li key={b}>
                      <button className="m-setting-row" onClick={() => onAt({ profileId: p.id, bucket: b, prefix: "" })}>
                        <Icon name="bucket" size={18} />
                        <span className="m-grow">{b}</span>
                        <Icon name="chevron" size={13} className="m-chev" />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )
        ) : error ? (
          <div className="m-empty">
            <div className="m-empty-art warn">
              <Icon name="alert" size={30} />
            </div>
            <h3>Couldn't open this folder</h3>
            <p className="m-empty-err">{error}</p>
            <button className="btn" onClick={() => onAt({ ...at })}>
              <Icon name="retry" size={14} /> Try again
            </button>
          </div>
        ) : (
          <ul className="m-list">
            {folders === null && (
              <li className="m-bucket-note">
                <span className="spinner" /> Loading folders…
              </li>
            )}
            {here.map((f) => (
              <li key={f} className="m-row">
                <button className="m-row-main" onClick={() => onAt({ ...at, prefix: f })}>
                  <span className="m-art">
                    <FileIcon entry={{ kind: "folder", key: f, name: baseName(f), size: 0, modified: null }} big />
                  </span>
                  <span className="m-row-text">
                    <span className="m-row-name">{baseName(f)}</span>
                  </span>
                  <Icon name="chevron" size={13} className="m-chev" />
                </button>
              </li>
            ))}
            <li className="m-row">
              {naming ? (
                <form
                  className="m-dest-new"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const n = newName.trim().replace(/^\/+|\/+$/g, "");
                    if (!n) return;
                    const prefix = `${at.prefix}${n}/`;
                    setMade((m) => [...m, prefix]);
                    setNewName("");
                    // folders only exist once something is in them: open it, the upload fills it
                    onAt({ ...at, prefix });
                  }}
                >
                  <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Folder name" enterKeyHint="done" autoCapitalize="off" />
                  <button className="m-text-btn" type="submit">
                    Create
                  </button>
                </form>
              ) : (
                <button className="m-row-main m-accent" onClick={() => setNaming(true)}>
                  <span className="m-art m-art-icon">
                    <Icon name="folder-plus" size={22} />
                  </span>
                  <span className="m-row-text">
                    <span className="m-row-name">New folder</span>
                  </span>
                </button>
              )}
            </li>
          </ul>
        )}
      </div>
      {at && (
        <nav className="m-actionbar m-dest-bar">
          <button className="btn btn-primary m-big-btn" onClick={() => onPick(at)}>
            <Icon name="upload" size={16} /> Upload here
          </button>
        </nav>
      )}
    </section>
  );
}
