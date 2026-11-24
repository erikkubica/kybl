/**
 * The pane's info panel: context for the folder on screen, not a file preview. The connection
 * (kind, server, user), the path with a copy button, the folder's item count and size, and for a
 * folder of this computer inside a git work tree: the branch, how far it is from its upstream,
 * changed, staged and untracked counts with a short list of changed files, and the last commit.
 * Loaded on first use (BrowserPane lazy-loads this file). Git is asked of the backend when the
 * folder changes and when the window comes back, never on a timer; no git, no git section.
 */
import { useEffect, useMemo, useState } from "react";
import { Icon } from "../Icons";
import { formatBytes } from "../format";
import { addressOf, kindInfo, pickOf } from "../connections/kinds";
import { providerMeta } from "../providers";
import { devtoolsApi, type GitCommit } from "./devtoolsApi";
import { ago, connectionFacts, gitCounts, type Fact } from "./infoFacts";
import type { Pane } from "./usePane";
import type { Entry } from "../types";

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
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [path]);
  const copy = () => {
    void navigator.clipboard?.writeText(path).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  // ---- the folder
  const entries = ent.search ? [] : ent.entries;
  const files = entries.filter((e) => e.kind === "file");
  const bytes = files.reduce((n, e) => n + (e.size || 0), 0);
  const whole = pane.folderSizes.get(prefix);
  const more = ent.moreOnServer;

  // ---- the last commit (the status itself comes from the pane's git hook)
  const info = git.info;
  const [commit, setCommit] = useState<GitCommit | null>(null);
  useEffect(() => {
    if (!info || !profile || bucket == null) return setCommit(null);
    let live = true;
    devtoolsApi
      .gitLastCommit(profile.id, bucket, prefix)
      .then((c) => live && setCommit(c))
      .catch(() => live && setCommit(null));
    return () => {
      live = false;
    };
    // a fresh status (folder opened, window back in front, a change made here) asks again
  }, [info, profile?.id, bucket, prefix]);

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
        <Rows facts={facts} />
      </section>

      <section>
        <h3>Folder</h3>
        <div className="info-path">
          <code title={path}>{path}</code>
          <button type="button" className="icon-btn" onClick={copy} title="Copy path" aria-label="Copy path">
            <Icon name={copied ? "check" : "copy"} size={13} />
          </button>
        </div>
        <Rows
          facts={[
            // search results are not the folder's own items
            ...(ent.search ? [] : [{ label: "Items", value: `${entries.length.toLocaleString()}${more ? "+" : ""}` }]),
            ...(!ent.search && files.length ? [{ label: "Size of files here", value: `${formatBytes(bytes)}${more ? " so far" : ""}` }] : []),
            ...(whole?.state === "done" ? [{ label: "Whole folder", value: `${formatBytes(whole.bytes)} in ${whole.objects.toLocaleString()}` }] : []),
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
          <Rows
            facts={[
              { label: "Changed", value: String(counts.changed) },
              { label: "Staged", value: String(counts.staged) },
              { label: "Untracked", value: String(counts.untracked) },
            ]}
          />
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
          {commit && (
            <div className="info-commit">
              <span className="info-hash">{commit.hash}</span>
              <span className="info-subject" title={commit.subject}>
                {commit.subject}
              </span>
              <span className="info-when">{ago(commit.time)}</span>
            </div>
          )}
        </section>
      )}
    </aside>
  );
}
