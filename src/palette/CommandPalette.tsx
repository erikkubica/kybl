/**
 * The command palette (⌘K): one field that finds connections, places, commands and the files of
 * the folder on screen, ranked together. `>` narrows to commands, `@` to connections, and `/` or
 * `~` types a path (Tab completes a folder). ↵ opens in the active pane, ⌘↵ in a new pane to the
 * right (or, for a file, shows it in the list). Loaded on first use, as its own chunk.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { THIS_MAC, type Loc } from "../browser/types";
import { ProviderBadge } from "../components/Sidebar";
import { groupLabel, groupOf } from "../connections/groups";
import { addressOf, kindInfo, pickOf } from "../connections/kinds";
import { closestLocalRoot, deviceIcon, setRootNames } from "../connections/roots";
import { baseName } from "../format";
import { Icon, type IconName } from "../Icons";
import { key } from "../components/keys";
import { providerMeta } from "../providers";
import type { Entry, Profile } from "../types";
import { registeredCommands, type PaletteCommand } from "./commands";
import { matchWords, runs } from "./fuzzy";
import { notePick, recentPicks, recentPlaces } from "./recent";
import { shellCommands } from "./shellCommands";
import type { PaletteHost } from "./types";
import "./palette.css";

type SectionId = "recent" | "connections" | "places" | "commands" | "files" | "path";
type Mode = "all" | "commands" | "connections" | "path";

type Item = {
  key: string;
  section: SectionId;
  title: string;
  /** dim text after the title */
  detail?: string;
  /** matched too, never shown as such (host, keywords) */
  extra?: string;
  /** right side: a shortcut (kbd) or a kind */
  hint?: string;
  kbd?: boolean;
  icon?: IconName;
  profile?: Profile;
  disabled?: string | null;
  /** Tab puts this in the field */
  complete?: string;
  /** what ⌘↵ does, when it does something else than ↵ */
  alt?: string;
  /** keeps the palette open (a "more" row) */
  stay?: boolean;
  run: (alt: boolean) => void | Promise<unknown>;
};
type Row = { kind: "head"; label: string } | { kind: "item"; item: Item; hits: number[]; i: number };

const SECTION_LABEL: Record<SectionId, string> = {
  recent: "Recent",
  connections: "Connections",
  places: "Places",
  commands: "Commands",
  files: "Files",
  path: "Go to",
};
/** small nudges so a tie goes the expected way (files are many, commands are what ⌘K is for) */
const BIAS: Record<SectionId, number> = { recent: 0, connections: 0.15, places: 0.1, commands: 0.2, files: -0.25, path: 0 };
/** rows per section with everything mixed; a section opened with "more" (or alone) shows up to MAX */
const CAP: Record<SectionId, number> = { recent: 6, connections: 6, places: 6, commands: 7, files: 6, path: 50 };
const MAX = 50;
const FIRST_COMMANDS = ["app:split-right", "app:new-folder", "app:upload-files", "app:go-to", "app:new-workspace", "app:settings"];

const isMacLike = /Mac|iPhone|iPad/i.test(navigator.userAgent);
const MOD = isMacLike ? "⌘" : "Ctrl+";

/** This computer's home folder (the root of kind "home"), asked once. */
let homeAsk: Promise<string | null> | null = null;
function homeDir(): Promise<string | null> {
  homeAsk ??= api
    .listRoots(THIS_MAC.id)
    .then((rs) => {
      // (the roots' names also tell closestLocalRoot which root holds a typed path)
      setRootNames(THIS_MAC.id, rs);
      return rs.find((r) => r.kind === "home")?.id ?? null;
    })
    .catch(() => null);
  return homeAsk;
}

const trimSlash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
/** an absolute path on this computer as (root, prefix): the closest root holding it */
function localLoc(abs: string): Loc {
  const path = trimSlash(abs);
  const root = closestLocalRoot(THIS_MAC.id, "/", path.replace(/^\/+/, ""));
  const base = trimSlash(root);
  const rel = path === base ? "" : path.slice(base === "/" ? 1 : base.length + 1);
  return { profileId: THIS_MAC.id, bucket: root, prefix: rel ? `${rel}/` : "" };
}
const absOf = (loc: Loc) => {
  const base = trimSlash(loc.bucket);
  return (base === "/" ? "/" : `${base}/`) + loc.prefix;
};
const tildify = (abs: string, home: string | null) => (home && (abs === home || abs.startsWith(`${home}/`)) ? `~${abs.slice(home.length)}` : abs);

export default function CommandPalette({
  host,
  onPick,
  onClose,
  typedEarly,
}: {
  host: PaletteHost;
  /** closes the palette, then runs the pick */
  onPick: (run: () => void | Promise<unknown>) => void;
  onClose: () => void;
  /** what was typed while this chunk was loading */
  typedEarly?: () => string;
}) {
  const h = useRef(host);
  h.current = host;
  const [query, setQuery] = useState(() => typedEarly?.() ?? "");
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<Set<SectionId>>(new Set());
  const [home, setHome] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    input.current?.focus();
    void homeDir().then(setHome);
  }, []);

  const a = host.active;
  const onDisk = !!a.caps?.localPaths || a.profile?.id === THIS_MAC.id;
  const picks = useMemo(() => recentPicks(), []);
  const pickRank = useMemo(() => new Map(picks.map((k, i) => [k, i])), [picks]);

  // ---------------------------------------------------------------- what can be found
  const commands: Item[] = useMemo(() => {
    const all: PaletteCommand[] = [...shellCommands(host), ...registeredCommands()];
    const seen = new Set<string>();
    return all
      .filter((c) => !seen.has(c.id) && !!seen.add(c.id))
      .map((c) => ({
        key: `cmd:${c.id}`,
        section: "commands" as const,
        title: c.title,
        detail: c.group,
        extra: [c.group, c.keywords].filter(Boolean).join(" "),
        hint: c.shortcut && key(c.shortcut),
        kbd: !!c.shortcut,
        icon: c.icon ?? "chevron",
        disabled: c.disabled || null,
        run: c.run,
      }));
    // built once per opening: what's disabled is as it was when the palette came up
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connections: Item[] = useMemo(
    () =>
      host.profiles.map((p) => {
        const own = host.builtIn(p);
        const group = groupLabel(groupOf(p));
        const kind = own ? "" : p.kind && p.kind !== "s3" ? kindInfo(pickOf(p)).label : providerMeta(p.provider).short;
        const addr = own ? "" : addressOf(p);
        return {
          key: `conn:${p.id}`,
          section: "connections" as const,
          title: p.name,
          detail: group || undefined,
          extra: [group, addr, p.net?.user ? `${p.net.user}@${addr}` : "", kind, p.kind === "sftp" ? "ssh" : ""].filter(Boolean).join(" "),
          hint: kind,
          profile: p,
          alt: "new pane",
          run: (alt: boolean) => h.current.openConnection(p, alt),
        };
      }),
    [host.profiles, host.builtIn],
  );

  /** where a place is, in a few words: "~/Documents/Contracts" or "Production · media/photos" */
  const placeDetail = (loc: Loc) => {
    if (loc.profileId === THIS_MAC.id) return tildify(trimSlash(absOf(loc)), home);
    const conn = host.profiles.find((p) => p.id === loc.profileId)?.name ?? "";
    const where = loc.bucket === "" ? `/${loc.prefix}` : `${host.rootLabel(loc.profileId, loc.bucket)}/${loc.prefix}`;
    return `${conn} · ${where.replace(/\/$/, "")}`;
  };
  const placeTitle = (loc: Loc) => (loc.prefix ? baseName(loc.prefix) : host.rootLabel(loc.profileId, loc.bucket));
  /** a place as the field would take it as a path (for Tab) */
  const pathOf = (loc: Loc) => (loc.profileId === THIS_MAC.id ? tildify(absOf(loc), home) : `/${loc.prefix}`);

  const places: Item[] = useMemo(() => {
    const known = new Set(host.profiles.map((p) => p.id));
    const favs = host.favorites
      .filter((f) => known.has(f.profileId))
      .map((f) => {
        const loc = { profileId: f.profileId, bucket: f.bucket, prefix: f.prefix };
        return {
          key: `fav:${f.profileId}|${f.bucket}|${f.prefix}`,
          section: "places" as const,
          title: f.name,
          detail: placeDetail(loc),
          extra: `favorite ${placeDetail(loc)}`,
          icon: "star" as IconName,
          alt: "new pane",
          run: (alt: boolean) => h.current.openFavorite(f, alt),
        };
      });
    const favKeys = new Set(favs.map((f) => f.key.slice(4)));
    const here = a.here;
    const recent = recentPlaces()
      .filter((l) => known.has(l.profileId) && !favKeys.has(`${l.profileId}|${l.bucket}|${l.prefix}`))
      .filter((l) => !(here && l.profileId === here.profileId && l.bucket === here.bucket && l.prefix === here.prefix))
      .map((loc) => ({
        key: `place:${loc.profileId}|${loc.bucket}|${loc.prefix}`,
        section: "places" as const,
        title: placeTitle(loc),
        detail: placeDetail(loc),
        extra: `recent ${placeDetail(loc)}`,
        icon: "clock" as IconName,
        alt: "new pane",
        run: (alt: boolean) => h.current.openPlace(loc, alt),
      }));
    return [...favs, ...recent];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.favorites, host.profiles, home]);

  // the folder on screen: its folders are places, its files are files
  const entries = a.ent.fresh || a.ent.search ? a.ent.allEntries : null;
  const listed = useMemo(() => {
    const folders: Item[] = [];
    const files: Item[] = [];
    if (!entries || !a.profile || a.bucket == null) return { folders, files };
    const p = a.profile;
    const b = a.bucket;
    const where = a.here ? placeTitle(a.here) : "";
    for (const e of entries) {
      const loc = { profileId: p.id, bucket: b, prefix: e.kind === "folder" ? e.key : e.key.slice(0, e.key.length - e.name.length) };
      if (e.kind === "folder")
        folders.push({
          key: `dir:${p.id}|${b}|${e.key}`,
          section: "places",
          title: e.name,
          detail: `in ${where}`,
          icon: "folder",
          complete: pathOf(loc),
          alt: "new pane",
          run: (alt) => h.current.openPlace(loc, alt),
        });
      else
        files.push({
          key: `file:${p.id}|${b}|${e.key}`,
          section: "files",
          title: e.name,
          detail: a.ent.search ? e.key.slice(0, e.key.length - e.name.length) || undefined : undefined,
          icon: "file",
          alt: "show in list",
          run: (alt) => openFile(e, alt),
        });
    }
    return { folders, files };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, a.profile, a.bucket, home]);

  const openFile = (e: Entry, reveal: boolean) => {
    const pane = h.current.active;
    pane.sel.setSelected(new Set([e.key]));
    pane.sel.setCursor(e.key, true);
    if (!reveal) pane.openEntry(e);
  };

  // ---------------------------------------------------------------- the query
  const trimmed = query.trimStart();
  const mode: Mode = trimmed.startsWith(">") ? "commands" : trimmed.startsWith("@") ? "connections" : /^[/~]/.test(trimmed) ? "path" : "all";
  const text = mode === "commands" || mode === "connections" ? trimmed.slice(1).trim() : trimmed.trim();
  const words = useMemo(() => text.toLowerCase().split(/\s+/).filter(Boolean), [text]);

  // ---- paths: the typed folder's listing, for completion
  const path = useMemo(() => {
    if (mode !== "path") return null;
    const typed = text.replace(/\\/g, "/");
    const raw = typed === "~" ? "~/" : typed;
    const local = raw.startsWith("~") || onDisk || a.bucket == null;
    if (raw.startsWith("~") && !home) return { pending: true as const };
    const expanded = raw.startsWith("~") ? home + raw.slice(1) : raw;
    const cut = expanded.lastIndexOf("/");
    const dir = expanded.slice(0, cut + 1);
    const frag = expanded.slice(cut + 1);
    const shownDir = raw.slice(0, raw.lastIndexOf("/") + 1);
    const loc: Loc = local ? localLoc(dir) : { profileId: a.profile!.id, bucket: a.bucket!, prefix: dir.replace(/^\/+/, "") };
    return { pending: false as const, local, expanded, dir, frag, shownDir, loc };
  }, [mode, text, home, onDisk, a.bucket, a.profile]);

  const [dirList, setDirList] = useState<{ key: string; folders: string[]; files: string[]; error?: string } | null>(null);
  const cache = useRef(new Map<string, Promise<{ folders: string[]; files: string[] }>>());
  const dirKey = path && !path.pending ? JSON.stringify(path.loc) : "";
  useEffect(() => {
    if (!path || path.pending) return;
    const loc = path.loc;
    const here = a.here;
    // the folder on screen is listed already
    if (here && entries && here.profileId === loc.profileId && here.bucket === loc.bucket && here.prefix === loc.prefix && !a.ent.search) {
      setDirList({ key: dirKey, folders: entries.filter((e) => e.kind === "folder").map((e) => e.key), files: entries.filter((e) => e.kind === "file").map((e) => e.key) });
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      let ask = cache.current.get(dirKey);
      if (!ask) {
        ask = api.listObjects(loc.profileId, loc.bucket, loc.prefix, null).then((r) => ({ folders: r.folders, files: r.objects.map((o) => o.key) }));
        cache.current.set(dirKey, ask);
        ask.catch(() => cache.current.delete(dirKey));
      }
      ask.then(
        (r) => live && setDirList({ key: dirKey, ...r }),
        () => live && setDirList({ key: dirKey, folders: [], files: [], error: "Can’t list this folder" }),
      );
    }, 90);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirKey]);

  const pathItems: Item[] = useMemo(() => {
    if (!path) return [];
    if (path.pending) return [];
    const { loc, frag, shownDir, local, expanded } = path;
    const out: Item[] = [];
    const got = dirList?.key === dirKey ? dirList : null;
    const lowFrag = frag.toLowerCase();
    const dot = frag.startsWith(".");
    const pick = (keys: string[], folder: boolean) =>
      keys
        .map((k) => ({ k, name: baseName(k) }))
        .filter(({ name }) => (dot || !name.startsWith(".")) && (!frag || name.toLowerCase().includes(lowFrag) || matchWords([lowFrag], name)))
        .map(({ k, name }) => {
          const low = name.toLowerCase();
          const rank = !frag ? 0 : low.startsWith(lowFrag) ? 0 : low.includes(lowFrag) ? 1 : 2;
          return { k, name, rank, folder };
        });
    const found = [...pick(got?.folders ?? [], true), ...pick(got?.files ?? [], false)].sort(
      (x, y) => x.rank - y.rank || Number(y.folder) - Number(x.folder) || x.name.localeCompare(y.name, undefined, { numeric: true }),
    );
    const exactFile = found.find((f) => !f.folder && f.name === frag);
    // the typed path itself: first when it names a folder ("…/"), else after the best completion
    const literal: Item = {
      key: `path:${expanded}`,
      section: "path",
      title: frag ? `${shownDir}${frag}` : shownDir || "/",
      detail: got?.error ?? (local ? "This Mac" : `${a.profile?.name ?? ""}${a.bucket ? ` · ${h.current.rootLabel(a.profile!.id, a.bucket)}` : ""}`),
      icon: "arrow-right",
      alt: "new pane",
      run: (alt) => {
        if (exactFile) return h.current.openPlace(loc, alt, exactFile.k);
        if (!frag) return h.current.openPlace(loc, alt);
        if (local) return h.current.openPlace(localLoc(expanded), alt);
        if (alt) return h.current.openPlace({ ...loc, prefix: `${loc.prefix}${frag}/` }, true);
        void h.current.active.actions.goToPath(text);
      },
    };
    const comps = found.slice(0, MAX).map(
      (f): Item => ({
        key: `pathc:${loc.profileId}|${loc.bucket}|${f.k}`,
        section: "path",
        title: f.name + (f.folder ? "/" : ""),
        detail: shownDir,
        icon: f.folder ? "folder" : "file",
        complete: f.folder ? `${shownDir}${f.name}/` : undefined,
        alt: "new pane",
        run: (alt) => (f.folder ? h.current.openPlace({ ...loc, prefix: f.k }, alt) : h.current.openPlace(loc, alt, f.k)),
      }),
    );
    if (frag && comps.length && found[0].rank === 0) out.push(comps[0], literal, ...comps.slice(1));
    else out.push(literal, ...comps);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, dirList, dirKey]);

  // ---------------------------------------------------------------- ranking
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    let i = 0;
    const push = (label: string, items: { item: Item; hits: number[] }[]) => {
      if (!items.length) return;
      out.push({ kind: "head", label });
      for (const x of items) out.push({ kind: "item", item: x.item, hits: x.hits, i: i++ });
    };
    const more = (section: SectionId, left: number): { item: Item; hits: number[] } => ({
      hits: [],
      item: {
        key: `more:${section}`,
        section,
        title: `${left.toLocaleString()} more…`,
        icon: "more",
        stay: true,
        run: () => setExpanded((cur) => new Set(cur).add(section)),
      },
    });
    const capOf = (s: SectionId, alone: boolean) => (alone || expanded.has(s) ? MAX : CAP[s]);

    if (mode === "path") {
      if (path?.pending) return out;
      push(SECTION_LABEL.path, pathItems.slice(0, MAX + 1).map((item) => ({ item, hits: [] })));
      return out;
    }

    const pools: Record<Exclude<SectionId, "recent" | "path">, Item[]> = {
      connections: mode === "commands" ? [] : connections,
      places: mode === "all" ? [...places, ...listed.folders] : [],
      commands: mode === "connections" ? [] : commands,
      files: mode === "all" ? listed.files : [],
    };
    const alone = mode !== "all";

    if (!words.length) {
      // nothing typed: recent picks first, then a little of each
      const byKey = new Map<string, Item>();
      for (const it of [...commands, ...connections, ...places, ...listed.folders, ...listed.files]) byKey.set(it.key, it);
      const recent = alone ? [] : picks.map((k) => byKey.get(k)).filter((x): x is Item => !!x && !x.disabled);
      const shown = new Set(recent.slice(0, CAP.recent).map((x) => x.key));
      push(SECTION_LABEL.recent, recent.slice(0, CAP.recent).map((item) => ({ item, hits: [] })));
      const rest = (s: keyof typeof pools, items: Item[], label = SECTION_LABEL[s]) => {
        const left = items.filter((x) => !shown.has(x.key));
        const cap = capOf(s, alone);
        const list = left.slice(0, cap).map((item) => ({ item, hits: [] as number[] }));
        if (left.length > cap) list.push(more(s, left.length - cap));
        push(label, list);
      };
      if (mode !== "commands") {
        const order = new Map(h.current.recentConnections.map((id, n) => [id, n]));
        rest("connections", [...connections].sort((x, y) => (order.get(x.profile!.id) ?? 1e9) - (order.get(y.profile!.id) ?? 1e9)));
      }
      if (mode === "all") rest("places", places);
      if (mode !== "connections") rest("commands", alone ? commands : FIRST_COMMANDS.map((id) => byKey.get(`cmd:${id}`)).filter((x): x is Item => !!x && !x.disabled));
      return out;
    }

    type Scored = { item: Item; hits: number[]; score: number };
    const sections: { id: SectionId; items: Scored[]; best: number }[] = [];
    for (const id of Object.keys(pools) as (keyof typeof pools)[]) {
      const scored: Scored[] = [];
      for (const item of pools[id]) {
        const m = matchWords(words, item.title, item.extra ?? item.detail);
        if (!m) continue;
        const r = pickRank.get(item.key);
        const recency = r == null ? 0 : Math.max(0, 1.2 - r * 0.04);
        scored.push({ item, hits: m.hits, score: m.score + BIAS[id] + recency - (item.disabled ? 0.6 : 0) });
      }
      if (!scored.length) continue;
      scored.sort((x, y) => y.score - x.score || x.item.title.length - y.item.title.length);
      const cap = capOf(id, alone);
      const list: { item: Item; hits: number[] }[] = scored.slice(0, cap);
      if (scored.length > cap) list.push(more(id, scored.length - cap));
      sections.push({ id, items: list as Scored[], best: scored[0].score });
    }
    sections.sort((x, y) => y.best - x.best);
    const fileHead = a.here ? `Files in ${placeTitle(a.here)}` : SECTION_LABEL.files;
    for (const s of sections) push(s.id === "files" ? fileHead : SECTION_LABEL[s.id], s.items);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, words, commands, connections, places, listed, pathItems, path, expanded, picks, pickRank]);

  const items = useMemo(() => rows.flatMap((r) => (r.kind === "item" ? [r.item] : [])), [rows]);
  // a new query starts at the top
  useEffect(() => setCursor(0), [query]);
  const at = Math.min(cursor, Math.max(0, items.length - 1));
  const current = items[at] as Item | undefined;

  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at, rows]);

  const run = (it: Item | undefined, alt: boolean) => {
    if (!it || it.disabled) return;
    if (it.stay) return void it.run(alt);
    if (!it.key.startsWith("more:")) notePick(it.key);
    onPick(() => it.run(alt));
  };
  const complete = () => {
    if (current?.complete) setQuery(current.complete);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    const n = items.length;
    const mod = e.metaKey || e.ctrlKey;
    const move = (d: number) => {
      e.preventDefault();
      if (n) setCursor((c) => (Math.min(c, n - 1) + d + n) % n);
    };
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) move(1);
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) move(-1);
    else if (e.key === "PageDown") {
      e.preventDefault();
      setCursor((c) => Math.min(n - 1, c + 8));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 8));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(current, mod);
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (!e.shiftKey) complete();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (mod && (e.key === "w" || e.key === "W")) {
      e.preventDefault();
      onClose();
    }
  };

  const placeholder = mode === "path" ? "Type a path…" : "Search connections, folders, commands and files…";
  const hint = current?.disabled ? null : current;
  const pathHelp = mode === "path" && path?.pending ? "Finding your home folder…" : null;

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        // the field keeps the keyboard (every key of the palette is handled there): a press on a
        // heading, the footer or the magnifier doesn't take it away
        onMouseDown={(e) => e.target !== input.current && e.preventDefault()}
      >
        <div className="palette-field">
          <Icon name="search" size={15} />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder={placeholder}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={current ? `palette-row-${at}` : undefined}
          />
          {mode !== "all" && <span className="palette-mode">{mode === "commands" ? "Commands" : mode === "connections" ? "Connections" : "Path"}</span>}
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {rows.map((r, n) =>
            r.kind === "head" ? (
              <div key={`h${n}`} className="palette-head" role="presentation">
                {r.label}
              </div>
            ) : (
              <PaletteRow key={r.item.key} row={r} on={r.i === at} onHover={() => r.i !== at && setCursor(r.i)} onRun={(alt) => run(r.item, alt)} />
            ),
          )}
          {!rows.length && <div className="palette-empty">{pathHelp ?? (mode === "path" ? "Listing…" : "Nothing found")}</div>}
        </div>
        <div className="palette-foot" aria-hidden="true">
          <span>
            <kbd>↵</kbd> {hint?.stay ? "show" : "open"}
          </span>
          {hint?.alt && (
            <span>
              <kbd>{MOD}↵</kbd> {hint.alt}
            </span>
          )}
          {hint?.complete && (
            <span>
              <kbd>⇥</kbd> complete
            </span>
          )}
          <span className="palette-prefixes">
            <b>&gt;</b> commands <b>@</b> connections <b>/</b> path
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

function PaletteRow({ row, on, onHover, onRun }: { row: Extract<Row, { kind: "item" }>; on: boolean; onHover: () => void; onRun: (alt: boolean) => void }) {
  const it = row.item;
  return (
    <div
      id={`palette-row-${row.i}`}
      data-i={row.i}
      role="option"
      aria-selected={on}
      aria-disabled={!!it.disabled || undefined}
      className={`palette-row ${on ? "on" : ""} ${it.disabled ? "off" : ""}`}
      // only a real pointer move picks a row (not rows sliding under a still pointer while scrolling)
      onMouseMove={onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => onRun(e.metaKey || e.ctrlKey)}
      title={it.disabled ?? undefined}
    >
      <span className="palette-icon">
        {it.profile ? (
          it.profile.id === THIS_MAC.id ? (
            <span className="pbadge local" aria-hidden="true">
              <Icon name={deviceIcon} size={12} />
            </span>
          ) : (
            <ProviderBadge provider={it.profile.provider} />
          )
        ) : (
          <Icon name={it.icon ?? "chevron"} size={14} />
        )}
      </span>
      <span className="palette-title">
        {runs(it.title, row.hits).map((r, n) => (r.hit ? <mark key={n}>{r.text}</mark> : <span key={n}>{r.text}</span>))}
      </span>
      {(it.disabled || it.detail) && <span className="palette-detail">{it.disabled ?? it.detail}</span>}
      {it.hint && (it.kbd ? <kbd className="palette-kbd">{it.hint}</kbd> : <span className="palette-hint">{it.hint}</span>)}
    </div>
  );
}
