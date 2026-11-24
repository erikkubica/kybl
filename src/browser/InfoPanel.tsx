/**
 * The pane's info panel: context for the folder on screen, not a file preview. The connection
 * (kind, server, user), the path with a copy button, the folder's item count and size, and for a
 * folder of this computer inside a git work tree: the branch and what it tracks, the remote, the
 * counts of changes with a short list of changed files, the last ten commits, a tag and stashes,
 * and the history of the one file selected. Loaded on first use (BrowserPane lazy-loads this
 * file). Git is asked of the backend when the folder changes, the status refreshes or the selected
 * file changes, never on a timer; no git, no git section.
 */
import { useEffect, useMemo, useState } from "react";
import { Icon } from "../Icons";
import { formatBytes, plural } from "../format";
import { addressOf, kindInfo, pickOf } from "../connections/kinds";
import { providerMeta } from "../providers";
import { devtoolsApi, type GitCommit, type GitOverview } from "./devtoolsApi";
import { ago, connectionFacts, gitChips, gitCounts, type Fact } from "./infoFacts";
import type { Pane } from "./usePane";
import type { Entry } from "../types";
import { TunnelList } from "../tunnels/TunnelBadge";
import { tunnelsOf } from "../tunnels/tunnels";
import { PHONE } from "../connections/fields";

/** How many changed files the panel lists before saying how many more there are. */
const LIST_MAX = 8;

const LETTER: Record<string, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", conflicted: "C", untracked: "U" };

function Rows({ facts }: { facts: Fact[] }) {
  return (
    <dl className="info-facts">
      {facts.map((f) => (
        <div key={f.label}>
          <dt>{f.label}</dt>
          <dd title={f.value}>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A small copy button that says it worked for a moment; `text` changing resets it. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [text]);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button type="button" className="icon-btn" onClick={copy} title={label} aria-label={label}>
      <Icon name={copied ? "check" : "copy"} size={13} />
    </button>
  );
}

/** How long a selection must stay put before git is asked about that file. */
const SELECT_DELAY = 250;

export default function InfoPanel({ pane }: { pane: Pane }) {
  const { profile, bucket, prefix, caps, git, ent } = pane;
  const root = bucket ?? "";
  const local = !!caps?.localPaths;

  // ---- the path, for copying
  const path = useMemo(() => {
    const dir = prefix.replace(/\/+$/, "");
    if (local) return `${root.replace(/\/+$/, "")}${dir ? `/${dir}` : ""}` || "/";
    const single = root === "";
    return single ? `/${dir}` : `${root}/${dir}`.replace(/\/$/, "");
  }, [local, root, prefix]);

  // ---- the folder
  // the whole folder, not the rows a name filter leaves
  const entries = ent.search ? [] : ent.allEntries;
  const files = entries.filter((e) => e.kind === "file");
  const bytes = files.reduce((n, e) => n + (e.size || 0), 0);
  const whole = pane.folderSizes.get(prefix);
  const more = ent.moreOnServer;

  // ---- the one file selected, by its name in this folder (search results are not this folder)
  const picked = pane.sel.selectedEntries;
  const only = !ent.search && picked.length === 1 && picked[0].kind === "file" && picked[0].key.startsWith(prefix) ? picked[0].key.slice(prefix.length) : null;
  // a moment's pause, so arrowing through files doesn't ask git for each one
  const [file, setFile] = useState<string | null>(null);
  useEffect(() => {
    if (only == null) return setFile(null);
    const t = window.setTimeout(() => setFile(only), SELECT_DELAY);
    return () => window.clearTimeout(t);
  }, [only]);

  // ---- the repository's overview (the status itself comes from the pane's git hook)
  const info = git.info;
  // every answer carries the folder (and file) it was asked for and is used only while those are
  // still the ones on screen, so a slow answer for the folder or file before never shows
  const here = `${profile?.id}\u0000${bucket}\u0000${prefix}`;
  const [overview, setOverview] = useState<{ at: string; ov: GitOverview } | null>(null);
  useEffect(() => {
    // the old folder's overview goes at once; the same folder's stays until the fresh one is in
    setOverview((o) => (o && o.at === here ? o : null));
    if (!info || !profile || bucket == null) return;
    let live = true;
    devtoolsApi
      .gitOverview(profile.id, bucket, prefix)
      .then((ov) => live && setOverview(ov ? { at: here, ov } : null))
      .catch(() => live && setOverview(null));
    return () => {
      live = false;
    };
    // a fresh status (folder opened, window back in front, a change made here) asks again
  }, [info, here]);
  const ov = overview && overview.at === here ? overview.ov : null;

  // the selected file's last commit: its own small question, asked only when the file changes
  const [fileLog, setFileLog] = useState<{ at: string; file: string; commit: GitCommit | null } | null>(null);
  useEffect(() => {
    if (!info || !profile || bucket == null || file == null) return setFileLog(null);
    let live = true;
    devtoolsApi
      .gitFileCommit(profile.id, bucket, prefix, file)
      .then((commit) => live && setFileLog({ at: here, file, commit }))
      .catch(() => live && setFileLog(null));
    return () => {
      live = false;
    };
    // a new status (the file may have been committed) asks again
  }, [info, here, file]);
  const fileCommit = fileLog && fileLog.at === here && fileLog.file === file ? fileLog : null;

  // ---- a cloud drive's space
  const cloud = !!profile?.cloud;
  const [quota, setQuota] = useState<{ used: number; total: number | null } | null>(null);
  useEffect(() => {
    setQuota(null);
    if (!cloud || !profile) return;
    let live = true;
    devtoolsApi
      .storageQuota(profile.id)
      .then((q) => live && setQuota(q))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [cloud, profile?.id]);

  if (!profile) return null;
  const kindLabel = profile.kind === "local" ? "This computer" : profile.kind && profile.kind !== "s3" ? kindInfo(pickOf(profile)).label : providerMeta(profile.provider).short;
  const facts = connectionFacts(profile, root);
  if (quota) facts.push({ label: "Space", value: quota.total ? `${formatBytes(quota.used)} of ${formatBytes(quota.total)} used` : `${formatBytes(quota.used)} used` });

  const counts = info ? gitCounts(info.changes) : null;
  const chips = counts ? gitChips(counts) : [];
  // the selected file's own status letter, when it has one
  const fileStatus = file != null && info ? info.changes.find((c) => c.path === file && c.kind !== "ignored") : undefined;
  const shown = info ? info.changes.filter((c) => c.kind !== "ignored") : [];
  const open = (rel: string) => {
    const key = `${prefix}${rel}`;
    if (rel.endsWith("/")) return pane.navigate(key);
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    const e: Entry = { kind: "file", key, name, size: 0, modified: null };
    pane.openEntry(e);
  };

  return (
    <aside className="info-panel" aria-label="Folder info">
      <section>
        <h3>{profile.name}</h3>
        <p className="info-kind" title={profile.kind === "local" ? undefined : addressOf(profile)}>
          {kindLabel}
        </p>
        {facts.length > 0 && <Rows facts={facts} />}
      </section>

      {/* an SFTP server's tunnels: what runs, Start / Stop, and where new ones are made */}
      {profile.kind === "sftp" && !PHONE && (
        <section className="info-tunnels">
          <h3>Tunnels</h3>
          {tunnelsOf(profile).length > 0 ? <TunnelList p={profile} /> : <p className="info-note">Forward a port on this computer to a service the server can reach, like a database.</p>}
          {pane.editTunnels && (
            <button type="button" className="btn btn-sm btn-ghost info-add" onClick={pane.editTunnels}>
              <Icon name="plus" size={12} /> {tunnelsOf(profile).length ? "Add or edit tunnels" : "Add a tunnel"}
            </button>
          )}
        </section>
      )}

      <section>
        <h3>Folder</h3>
        <div className="info-path">
          <code title={path}>{path}</code>
          <CopyButton text={path} label="Copy path" />
        </div>
        <Rows
          facts={[
            // search results are not the folder's own items
            ...(ent.search ? [] : [{ label: "Items", value: `${entries.length.toLocaleString()}${more ? "+" : ""}` }]),
            ...(!ent.search && files.length ? [{ label: "Size of files here", value: `${formatBytes(bytes)}${more ? " so far" : ""}` }] : []),
            ...(whole?.state === "done" ? [{ label: "Whole folder", value: `${formatBytes(whole.bytes)} in ${plural(whole.objects, "object")}` }] : []),
          ]}
        />
      </section>

      {info && counts && (
        <section>
          <h3>Git</h3>
          <p className="info-branch">
            <Icon name="branch" size={13} />
            <strong>{info.branch ?? `detached at ${info.commit ?? "a commit"}`}</strong>
            {(info.ahead > 0 || info.behind > 0) && (
              <span className="info-ab" title="Commits ahead of and behind the upstream branch">
                {info.ahead > 0 ? `↑${info.ahead}` : ""} {info.behind > 0 ? `↓${info.behind}` : ""}
              </span>
            )}
          </p>
          {ov && (
            <p className="info-quiet" title={ov.upstream ?? undefined}>
              {ov.upstream ? `tracks ${ov.upstream}${ov.fetchedAt ? ` · fetched ${ago(ov.fetchedAt)}` : ""}` : "no upstream"}
            </p>
          )}
          {ov?.remote && (
            <div className="info-path">
              <code title={ov.remote}>{ov.remote}</code>
              <CopyButton text={ov.remote} label="Copy remote address" />
            </div>
          )}
          {chips.length > 0 ? (
            <p className="info-chips">
              {chips.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </p>
          ) : (
            // a repository too big to check in time can't claim to be clean
            !info.partial && (
              <p className="info-chips">
                <span>Clean</span>
              </p>
            )
          )}
          {info.partial && <p className="info-note">The repository is big: these counts may be incomplete.</p>}
          {shown.length > 0 && (
            <ul className="info-changes">
              {shown.slice(0, LIST_MAX).map((c) => (
                <li key={c.path}>
                  {/* a deleted file is no longer there to open */}
                  {c.kind === "deleted" ? (
                    <span className="info-static" title={`${c.path} was deleted`}>
                      <span className={`info-mark ${c.kind}`}>{LETTER[c.kind] ?? ""}</span>
                      <span className="info-file">{c.path}</span>
                    </span>
                  ) : (
                    <button type="button" onClick={() => open(c.path)} title={`Open ${c.path}`}>
                      <span className={`info-mark ${c.kind}`}>{LETTER[c.kind] ?? ""}</span>
                      <span className="info-file">{c.path}</span>
                    </button>
                  )}
                </li>
              ))}
              {shown.length > LIST_MAX && <li className="info-more">and {(shown.length - LIST_MAX).toLocaleString()} more</li>}
            </ul>
          )}
          {ov && (ov.tag || ov.stashes > 0) && (
            <Rows
              facts={[
                ...(ov.tag ? [{ label: "Tag", value: ov.tag }] : []),
                ...(ov.stashes > 0 ? [{ label: "Stashes", value: String(ov.stashes) }] : []),
              ]}
            />
          )}
          {/* only an answer made for this very file, never the one for the file before it */}
          {file != null && fileCommit && (
            <div className="info-file-log">
              <h4>Selected file</h4>
              <p>
                {fileStatus && (
                  <span className={`info-mark ${fileStatus.kind}`} title={fileStatus.kind}>
                    {LETTER[fileStatus.kind] ?? ""}
                  </span>
                )}
                {fileCommit.commit ? (
                  <>
                    Last changed in <span className="info-hash">{fileCommit.commit.hash}</span> by {fileCommit.commit.author}, {ago(fileCommit.commit.time)}: <span title={fileCommit.commit.subject}>{fileCommit.commit.subject}</span>
                  </>
                ) : (
                  "Not committed yet"
                )}
              </p>
            </div>
          )}
          {ov && ov.commits.length > 0 && (
            <div className="info-commits">
              <h4>Recent commits</h4>
              <ul>
                {ov.commits.map((c) => (
                  <li key={c.hash}>
                    <span className="info-hash">{c.hash}</span>
                    <span className="info-subject" title={c.subject}>
                      {c.subject}
                    </span>
                    <span className="info-when">
                      {c.author} · {ago(c.time)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </aside>
  );
}
