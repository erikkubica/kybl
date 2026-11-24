/**
 * Sidebar groups (folders of connections), finding a connection by typing, and the recently
 * opened ones. A group is a slash-separated path saved on the profile (`group: "Clients/Acme"`);
 * groups have no record of their own, so one exists while a connection is filed under it.
 * Which groups are folded open and the recent list are kept per device (localStorage).
 */
import { useCallback, useState } from "react";
import { LS } from "../browser/types";
import { providerMeta } from "../providers";
import type { Profile } from "../types";
import { splitDavUrl } from "./serverHost";

import {
  allGroups,
  byName,
  groupChain,
  groupLabel,
  groupName,
  groupOf,
  groupTree,
  normalizeGroup,
  parentGroup,
  type GroupNode,
} from "./groupPaths";

export { allGroups, byName, groupChain, groupLabel, groupName, groupOf, groupTree, normalizeGroup, parentGroup };
export type { GroupNode };

// ---------------------------------------------------------------- kind sections

/**
 * Server kinds have no buckets to fold open, so a row each makes a wall: with a few of one kind
 * they go into a section for that kind ("FTP", "SFTP", "WebDAV") that folds open like a
 * connection does on its buckets. FTPS is FTP with TLS: one section.
 */
export const SECTION_KINDS: { kind: "ftp" | "sftp" | "webdav"; label: string }[] = [
  { kind: "ftp", label: "FTP" },
  { kind: "sftp", label: "SFTP" },
  { kind: "webdav", label: "WebDAV" },
];
/** With fewer of a kind they stay plain rows. */
export const SECTION_MIN = 3;

export type KindSection = {
  kind: "ftp" | "sftp" | "webdav";
  label: string;
  /** its key among the folded-open groups, and the scope of the groups inside it */
  key: string;
  tree: GroupNode;
};

export type SidebarLayout = {
  /** connections and groups at the top level (everything not in a section) */
  top: GroupNode;
  sections: KindSection[];
};

const sectionKey = (kind: string) => `kind:${kind}`;

/** The kinds that get a section for these connections. */
function sectionKinds(profiles: Profile[]): Set<string> {
  const n = new Map<string, number>();
  for (const p of profiles) n.set(p.kind ?? "s3", (n.get(p.kind ?? "s3") ?? 0) + 1);
  return new Set(SECTION_KINDS.filter((s) => (n.get(s.kind) ?? 0) >= SECTION_MIN).map((s) => s.kind));
}

/** The connections as the sidebar lays them out: the top level, and a section per server kind. */
export function sidebarLayout(profiles: Profile[]): SidebarLayout {
  const kinds = sectionKinds(profiles);
  const sections = SECTION_KINDS.filter((s) => kinds.has(s.kind)).map((s) => ({
    ...s,
    key: sectionKey(s.kind),
    tree: groupTree(
      profiles.filter((p) => p.kind === s.kind),
      true,
    ),
  }));
  // This Mac first: it's always there and always the same, so it shouldn't move as connections come and go
  const top = profiles.filter((p) => !kinds.has(p.kind ?? "s3"));
  const isLocal = (p: Profile) => p.kind === "local" || p.id === "local";
  return { top: groupTree([...top.filter(isLocal), ...top.filter((p) => !isLocal(p))]), sections };
}

/** Where a connection sits: the key of its section ("" at the top level). */
export function scopeOf(profiles: Profile[], p: Profile): string {
  return sectionKinds(profiles).has(p.kind ?? "s3") ? sectionKey(p.kind!) : "";
}

/** A group's key among the folded-open ones: its path, inside a section after the section's key. */
export const openKey = (scope: string, path: string) => (scope ? `${scope}|${path}` : path);

/** What has to be folded open to show `p`: its section, and the groups around it. */
export function revealKeys(profiles: Profile[], p: Profile): string[] {
  const scope = scopeOf(profiles, p);
  return [...(scope ? [scope] : []), ...groupChain(groupOf(p)).map((g) => openKey(scope, g))];
}

/** The connections a group's menu acts on: those listed with it (its section, or the top level). */
export function inScope(profiles: Profile[], scope: string): Profile[] {
  const kinds = sectionKinds(profiles);
  return profiles.filter((p) => (kinds.has(p.kind ?? "s3") ? sectionKey(p.kind!) : "") === scope);
}

/** Group changes, by connection id ("" = the top level), for `api.setProfileGroups`. */
export type GroupChanges = Record<string, string>;

/** Renames group `from` to `to` (which may move it inside another group): its connections and subgroups follow. */
export function renameGroup(profiles: Profile[], from: string, to: string): GroupChanges {
  const dest = normalizeGroup(to);
  const out: GroupChanges = {};
  for (const p of profiles) {
    const g = groupOf(p);
    if (g === from) out[p.id] = dest;
    else if (g.startsWith(`${from}/`)) out[p.id] = normalizeGroup(`${dest}/${g.slice(from.length + 1)}`);
  }
  return out;
}

/** Dissolves group `path`: what was in it moves up a level, into the group around it. */
export function ungroup(profiles: Profile[], path: string): GroupChanges {
  return renameGroup(profiles, path, parentGroup(path));
}

/** The folded-open groups after a rename: a renamed group (and those inside it) stays open. */
export function renamedOpen(open: Set<string>, from: string, to: string, scope = ""): Set<string> {
  const dest = normalizeGroup(to);
  const old = openKey(scope, from);
  const next = new Set<string>();
  for (const g of open) {
    if (g === old) {
      if (dest) next.add(openKey(scope, dest));
    } else if (g.startsWith(`${old}/`)) next.add(openKey(scope, normalizeGroup(`${dest}/${g.slice(old.length + 1)}`)));
    else next.add(g);
  }
  return next;
}

// ---------------------------------------------------------------- folded-open groups

const OPEN_KEY = "s3b.openGroups";
function loadOpen(): Set<string> {
  try {
    const v = JSON.parse(LS.get(OPEN_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Which groups are folded open in the sidebar (all start folded, so 500 connections fit on screen). */
export function useOpenGroups() {
  const [open, setOpenState] = useState<Set<string>>(loadOpen);
  const update = useCallback((fn: (cur: Set<string>) => Set<string>) => {
    setOpenState((cur) => {
      const next = fn(cur);
      if (next === cur) return cur;
      LS.set(OPEN_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);
  const toggle = useCallback(
    (path: string) =>
      update((cur) => {
        const next = new Set(cur);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      }),
    [update],
  );
  /** Folds open what shows a connection (the one on screen: `revealKeys`), keeping the rest as they are. */
  const reveal = useCallback(
    (keys: string[]) =>
      update((cur) => {
        if (keys.every((g) => cur.has(g))) return cur;
        return new Set([...cur, ...keys]);
      }),
    [update],
  );
  const collapseAll = useCallback(() => update((cur) => (cur.size ? new Set() : cur)), [update]);
  return { open, update, toggle, reveal, collapseAll };
}
export type OpenGroups = ReturnType<typeof useOpenGroups>;

// ---------------------------------------------------------------- recent

const RECENT_KEY = "s3b.recentConnections";
const RECENT_KEEP = 8;
/** How many recent connections the sidebar lists. */
export const RECENT_SHOWN = 5;
/** Below this many connections everything fits on screen: no Recent section, no filter needed. */
export const RECENT_MIN = 10;
export const FILTER_MIN = 8;

function loadRecent(): string[] {
  try {
    const v = JSON.parse(LS.get(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, RECENT_KEEP) : [];
  } catch {
    return [];
  }
}

/** The connections opened last, newest first (ids). */
export function useRecentConnections() {
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const push = useCallback((id: string) => {
    setRecent((cur) => {
      if (cur[0] === id) return cur;
      const next = [id, ...cur.filter((x) => x !== id)].slice(0, RECENT_KEEP);
      LS.set(RECENT_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const forget = useCallback((id: string) => {
    setRecent((cur) => {
      if (!cur.includes(id)) return cur;
      const next = cur.filter((x) => x !== id);
      LS.set(RECENT_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return { recent, push, forget };
}

// ---------------------------------------------------------------- finding by typing

export type Range = [start: number, end: number];
export type Found = {
  p: Profile;
  score: number;
  /** where the typed words are in the name */
  nameHits: Range[];
  /** the dim text after the name: the group, or what matched when the name didn't (host, user) */
  detail: string;
  detailHits: Range[];
};

/** Where a connection points, as typed in a search: host, address or account. */
function hostOf(p: Profile): string {
  // never with a user name or password that an older save left in the address
  if (p.net) return p.net.url ? splitDavUrl(p.net.url).href : p.net.host;
  if (p.blob) return [p.blob.account, p.blob.container].filter(Boolean).join("/");
  if (p.cloud) return p.cloud.accountEmail;
  return p.endpoint.replace(/^\w+:\/\//, "");
}
const userOf = (p: Profile) => p.net?.user ?? "";
/** Words for the kind: "sftp ssh", "ftp", "s3 hetzner", "gdrive google drive". */
function kindWords(p: Profile): string {
  const meta = providerMeta(p.provider);
  return [p.kind ?? "s3", p.provider, meta.short, meta.mono, p.kind === "sftp" ? "ssh" : ""].join(" ").toLowerCase();
}

function hits(text: string, tokens: string[]): Range[] {
  const low = text.toLowerCase();
  const out: Range[] = [];
  for (const t of tokens) {
    const i = low.indexOf(t);
    if (i >= 0) out.push([i, i + t.length]);
  }
  // merged and in order, for highlighting
  out.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/**
 * The connections matching what was typed: every word must be found in the name, group, host,
 * user or kind. Names that start with it come first, then a word in the name starting with it,
 * then the name containing it, then the other fields.
 */
export function findConnections(profiles: Profile[], query: string): Found[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const out: Found[] = [];
  for (const p of profiles) {
    const name = p.name.toLowerCase();
    const group = groupOf(p);
    const host = hostOf(p).toLowerCase();
    const user = userOf(p).toLowerCase();
    // "deploy@" and "deploy@www.acme" find the login as it's typed in a terminal
    const fields = { group: group.toLowerCase(), host, user: user ? `${user}@${host}` : "", kind: kindWords(p) };
    let score = 0;
    let ok = true;
    let viaHost = false;
    let viaUser = false;
    for (const t of tokens) {
      const i = name.indexOf(t);
      if (i === 0) score += 0;
      else if (i > 0 && /[\s._\-/@·()]/.test(name[i - 1])) score += 1;
      else if (i > 0) score += 2;
      else if (fields.group.includes(t)) score += 3;
      else if (fields.host.includes(t)) (score += 3), (viaHost = true);
      else if (fields.user.includes(t)) (score += 4), (viaUser = true);
      else if (fields.kind.includes(t)) score += 5;
      else {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const detail = viaHost ? hostOf(p) : viaUser ? `${userOf(p)}@${hostOf(p)}` : groupLabel(group);
    const detailTokens = viaHost || viaUser ? tokens : tokens.filter((t) => !name.includes(t));
    out.push({ p, score, nameHits: hits(p.name, tokens), detail, detailHits: hits(detail, detailTokens) });
  }
  // the same name in several groups ("Live" per client): by group
  return out.sort((a, b) => a.score - b.score || byName(a.p.name, b.p.name) || byName(groupOf(a.p), groupOf(b.p)));
}
