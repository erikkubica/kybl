/**
 * What the pane's info panel says about the connection and the folder, as plain label/value
 * pairs (pure, so it is tested without a screen), plus the git counts and the "2 hours ago" text.
 */
import type { Profile } from "../../core/types";

export type Fact = { label: string; value: string };

const PORTS: Record<string, number> = { ftp: 21, sftp: 22, webdav: 443 };

/** FTP and WebDAV say whether the line is encrypted; SFTP always is. */
function protocolOf(p: Profile): string {
  const n = p.net;
  switch (p.kind) {
    case "sftp":
      return "SFTP (encrypted)";
    case "ftp":
      if (!n || n.tls === "none") return "FTP, TLS off";
      if (n.tls === "auto") return "FTP, TLS when the server offers it";
      return `FTPS, TLS on (${n.tls === "implicit" ? "from the start" : "after connecting"})`;
    case "webdav": {
      const url = n?.url ?? "";
      const secure = url ? url.startsWith("https") : n?.tls !== "none";
      return secure ? "WebDAV, TLS on" : "WebDAV, TLS off";
    }
    default:
      return "";
  }
}

/** The connection's own facts: what kind it is and where it points. */
export function connectionFacts(p: Profile, root: string): Fact[] {
  const kind = p.kind ?? "s3";
  const out: Fact[] = [];
  const add = (label: string, value: string | null | undefined) => value && out.push({ label, value });
  // the kind line above the facts already says "This computer"
  if (kind === "local") return [];
  if (kind === "s3") {
    add("Bucket", root);
    add("Region", p.region);
    add("Endpoint", p.endpoint.replace(/^https?:\/\//, ""));
  } else if (p.net) {
    const n = p.net;
    let server = n.host;
    if (kind === "webdav" && n.url) server = n.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    else if (n.port && n.port !== PORTS[kind]) server = `${n.host}:${n.port}`;
    add("Server", server);
    add("Protocol", protocolOf(p));
    add("User", n.user);
  } else if (p.cloud) {
    add("Account", p.cloud.accountEmail);
  } else if (p.blob) {
    add(kind === "azblob" ? "Storage account" : "Project", p.blob.account);
    add(kind === "azblob" ? "Container" : "Bucket", p.blob.container);
  }
  return out;
}

export type GitCountsInput = { kind: string; staged: boolean; unstaged: boolean }[];

/** Changed, staged and untracked, as git's own summary counts them (ignored paths aren't changes). */
export function gitCounts(changes: GitCountsInput) {
  let changed = 0;
  let staged = 0;
  let untracked = 0;
  for (const c of changes) {
    if (c.kind === "ignored") continue;
    if (c.kind === "untracked") untracked++;
    else {
      if (c.staged) staged++;
      if (c.unstaged || c.kind === "conflicted") changed++;
    }
  }
  return { changed, staged, untracked };
}

/** The counts as short chips ("2 changed", "1 staged", "3 untracked"); zeros are left out, so none means clean. */
export function gitChips(c: { changed: number; staged: number; untracked: number }): string[] {
  return [
    ...(c.changed ? [`${c.changed.toLocaleString()} changed`] : []),
    ...(c.staged ? [`${c.staged.toLocaleString()} staged`] : []),
    ...(c.untracked ? [`${c.untracked.toLocaleString()} untracked`] : []),
  ];
}

/** "just now", "5 minutes ago", "3 days ago": the age of a commit. */
export function ago(unixSeconds: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round(nowMs / 1000 - unixSeconds));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (s < 45) return "just now";
  if (s < 3600) return unit(Math.max(1, Math.round(s / 60)), "minute");
  if (s < 86400) return unit(Math.round(s / 3600), "hour");
  if (s < 86400 * 30) return unit(Math.round(s / 86400), "day");
  if (s < 86400 * 365) return unit(Math.round(s / (86400 * 30)), "month");
  return unit(Math.round(s / (86400 * 365)), "year");
}
