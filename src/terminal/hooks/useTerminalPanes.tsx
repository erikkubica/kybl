/**
 * The shell's side of terminal panes: which pane slots show a terminal (and in which folder), the
 * ways to open one (⌘J or ⌃`, the sidebar button, the pane's ⋯ and folder menus, the command palette, `openTerminal`),
 * files dropped on one, following the folder of the pane it opened from, and ending the shells of
 * panes no workspace has any more.
 *
 * A terminal takes a pane slot like a file pane: the layout (paneLayout.ts) splits, drags, docks
 * and moves it the same way. Its slot's file pane sits idle, showing nothing, meanwhile.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../../core/api";
import { baseName } from "../../core/format";
import { LOCAL_PROFILE, type Loc, type PaneId } from "../../browser/types";
import type { Pane } from "../../browser/hooks/usePane";
import type { MenuItem } from "../../ui/components/Dialogs";
import type { ConfirmOptions, Dialogs } from "../../shell/hooks/useDialogs";
import type { Place } from "../../shell/lib/crossPane";
import { leaves } from "../../shell/lib/paneLayout";
import type { Layout, WorkspaceStore } from "../../shell/lib/workspaces";
import { registerCommands } from "../../palette/lib/commands";
import type { Entry, Profile } from "../../core/types";
import { TerminalSlot } from "../components/TerminalSlot";
import { PASTE_ASK_ALWAYS, pasteView } from "../lib/quote";
import { ON_OS, terminalsWhere } from "../../core/osNames";
import {
  canTerminal,
  gcTerminals,
  newSid,
  remotePath,
  setStartup,
  focusWhenShown,
  setTerminalOpener,
  setTerminalPanes,
  askBeforeEveryPaste,
  pasteTrustCount,
  setPasteConfirm,
  setTermNotice,
  termWriteWhy,
  type PasteAsk,
  cdLine,
  quoteAs,
  terminalQuoting,
  type Quoting,
  terminalIdle,
  terminalRemoteBase,
  typeIntoTerminal,
  writeToTerminal,
  type TermPlace,
  type TermSpec,
} from "../api";

// a name with control characters (or one this shell can't take, like `%` in Command Prompt)
const CANT_TYPE = "That name can't be typed into this shell, so it isn't pasted.";
const CANT_TYPE_SOME = "Names this shell can't take were left out.";

export type Terms = Partial<Record<PaneId, TermSpec>>;

/** Files from Finder / Explorer dropped on a terminal of a server: their paths mean nothing there. */
export const REMOTE_TERM_DROP = "That terminal runs on a server. Drop the files on a folder to upload them.";

/** What the hook needs from the shell, as of the latest render. */
export type TermHost = {
  profiles: Profile[];
  slot: (id: PaneId) => Pane;
  /** the panes on screen, and the one with the keyboard (maybe a terminal) */
  ids: PaneId[];
  activeId: PaneId;
  /** the file pane used last, on screen */
  fileId: PaneId | null;
  /** splits pane `src` downwards; `fill` gets the new slot (nothing when there's no room: the shell says why) */
  splitBelow: (src: PaneId, fill: (fresh: PaneId) => void) => void;
  /** the same, upwards (the new pane above `src`) */
  splitAbove: (src: PaneId, fill: (fresh: PaneId) => void) => void;
  /** the panes menu's items for pane `id` (split, move, size, close the others), for the terminal's ⋯ */
  paneItems: (id: PaneId) => MenuItem[];
  setActive: (id: PaneId) => void;
  focus: (id: PaneId) => void;
  close: (id: PaneId) => void;
  confirm: Dialogs["confirm"];
  menu: Dialogs["menu"];
  toast: Dialogs["toast"];
  rootLabel: (profileId: string, root: string) => string;
  /** the connections a terminal can run on, as a menu; `pick` once one is chosen (and a running program may end) */
  connMenu: (id: PaneId, x: number, y: number, current: string, pick: (profileId: string) => void) => void;
};

/** The terminals of a layout, each with a session id (a pane saved without one starts a shell of its own). */
export function termsOf(l: Layout): Terms {
  const out: Terms = {};
  for (const id of leaves(l.tree)) {
    const t = l.panes[id]?.term;
    if (t) out[id] = { ...t, sid: t.sid ?? newSid() };
  }
  return out;
}

export function useTerminalPanes(initial: Layout) {
  const [terms, setTerms] = useState<Terms>(() => termsOf(initial));
  const host = useRef<TermHost | null>(null);
  const termsRef = useRef(terms);
  termsRef.current = terms;
  useEffect(() => setTerminalPanes(terms), [terms]);
  useEffect(() => {
    setPasteConfirm(async (a) => {
      const choice = { trust: false };
      const ok = (await host.current?.confirm(pasteDialog(a, choice))) ?? false;
      return { ok, trust: ok && choice.trust };
    });
    setTermNotice((text) => host.current?.toast("info", text));
    return () => {
      setPasteConfirm(null);
      setTermNotice(null);
    };
  }, []);

  /** Slot `id` shows terminal `place` (a pane brought back by a workspace), or files (undefined). */
  const assign = (id: PaneId, place: TermPlace | undefined) =>
    setTerms((cur) => {
      if (!place) {
        if (!cur[id]) return cur;
        const next = { ...cur };
        delete next[id];
        return next;
      }
      return { ...cur, [id]: { ...place, sid: place.sid ?? newSid() } };
    });

  const profileOf = (id: string) => host.current?.profiles.find((p) => p.id === id) ?? null;

  // ---- following the folder of the pane a terminal opened from ("Follow the folder above")
  /** a word in a following terminal's header when it didn't follow (by session) */
  const [notes, setNotes] = useState<Record<string, string>>({});
  const note = (sid: string, text: string | null) =>
    setNotes((cur) => {
      if ((cur[sid] ?? null) === text) return cur;
      const next = { ...cur };
      if (text) next[sid] = text;
      else delete next[sid];
      return next;
    });
  /** the place each following terminal last saw its file pane at, and the latest follow under way */
  const seen = useRef(new Map<string, string>());
  const gen = useRef(new Map<string, number>());
  /**
   * Terminal `id` goes to `to` with ` cd 'path'` (a leading space keeps it out of the history), but
   * only into a shell idling at its prompt: never into a running program or a half-typed line.
   * A shell still drawing its prompt gets a moment; then it is left alone, and says so.
   */
  const follow = async (id: PaneId, t: TermSpec, to: Loc) => {
    const n = (gen.current.get(t.sid) ?? 0) + 1;
    gen.current.set(t.sid, n);
    const stale = () => gen.current.get(t.sid) !== n || termsRef.current[id]?.sid !== t.sid || !termsRef.current[id]?.follow;
    if (to.profileId !== t.profileId || (t.profileId !== LOCAL_PROFILE && to.bucket !== t.bucket)) return note(t.sid, "not following: another place");
    const local = t.profileId === LOCAL_PROFILE;
    // on this computer: the raw path, quoted only once the shell is up and has said its kind
    let raw: string | null = null;
    let path: string | null = null;
    if (local) {
      raw = await api.localPath(to.profileId, to.bucket, to.prefix.replace(/\/+$/, "")).catch(() => null);
      if (!raw || stale()) return;
    } else {
      const base = terminalRemoteBase(t.sid);
      if (base == null || stale()) return;
      path = remotePath(base, to.prefix);
      if (path == null) return note(t.sid, "not following: the folder name has control characters");
    }
    for (let i = 0; ; i++) {
      if (await terminalIdle(t.sid)) break;
      if (stale()) return;
      if (i >= 6) return note(t.sid, "not following: busy");
      await new Promise((r) => setTimeout(r, 120));
    }
    if (stale()) return;
    const q: Quoting | null = local ? terminalQuoting(t.sid) : "posix";
    if (!q) return;
    if (local) {
      path = quoteAs(q, raw!);
      if (path == null) return note(t.sid, "not following: this shell can't take that folder name");
    }
    if (!path) return;
    // csh and tcsh expand `!` even inside single quotes, and the shell's kind isn't known here
    // (the backend's remote_cd decides that for a fresh shell): such a name would run as history
    if ((q === "posix" || q === "wsl") && path.includes("!")) return note(t.sid, "not following: `!` in the folder name");
    if (stale() || !typeIntoTerminal(t.sid, cdLine(q, path))) return;
    note(t.sid, null);
    setTerms((cur) => (cur[id]?.sid === t.sid ? { ...cur, [id]: { ...cur[id]!, bucket: to.bucket, prefix: to.prefix } } : cur));
  };
  // after each render: a following terminal whose file pane went elsewhere goes there too
  useEffect(() => {
    const h = host.current;
    if (!h) return;
    const ts = termsRef.current;
    for (const id of h.ids) {
      const t = ts[id];
      if (!t?.follow || !t.from || !h.ids.includes(t.from) || ts[t.from]) continue;
      const to = h.slot(t.from).here;
      if (!to) continue;
      const key = `${to.profileId}\n${to.bucket}\n${to.prefix}`;
      if (seen.current.get(t.sid) === key) continue;
      seen.current.set(t.sid, key);
      if (to.profileId === t.profileId && to.bucket === t.bucket && to.prefix === t.prefix) note(t.sid, null);
      else void follow(id, t, to);
    }
  });
  /** "Follow the folder above" on or off for terminal pane `id`. */
  const setFollow = (id: PaneId, on: boolean) => {
    const t = termsRef.current[id];
    if (!t) return;
    seen.current.delete(t.sid);
    gen.current.delete(t.sid);
    note(t.sid, null);
    setTerms((cur) => {
      const c = cur[id];
      if (!c) return cur;
      const next = { ...c };
      if (on) next.follow = true;
      else delete next.follow;
      return { ...cur, [id]: next };
    });
  };

  /** A terminal below pane `src` at `at` (default: the folder `src` shows); its slot, or null when it couldn't. */
  const open = (src: PaneId, at?: Loc | null, startup?: string[]): PaneId | null => {
    const h = host.current;
    if (!h) return null;
    const t = termsRef.current[src];
    const loc = at ?? (t ? { profileId: t.profileId, bucket: t.bucket, prefix: t.prefix } : h.slot(src).here);
    if (!loc) {
      h.toast("info", "Open a folder first, then a terminal in it.");
      return null;
    }
    if (!canTerminal(profileOf(loc.profileId))) {
      h.toast("info", `${terminalsWhere()}.`);
      return null;
    }
    let made: PaneId | null = null;
    h.splitBelow(src, (fresh) => {
      made = fresh;
      const sid = newSid();
      setStartup(sid, startup);
      focusWhenShown(sid);
      h.slot(fresh).showConnection(null);
      setTerms((cur) => ({ ...cur, [fresh]: { ...loc, sid, from: t?.from ?? src } }));
    });
    return made;
  };

  /** ⌘J or ⌃`: from a file pane to its terminal (opening one below it the first time), from a terminal back to its file pane. */
  const toggle = () => {
    const h = host.current;
    if (!h) return;
    const ts = termsRef.current;
    const cur = ts[h.activeId];
    if (cur) {
      const back = cur.from && h.ids.includes(cur.from) && !ts[cur.from] ? cur.from : h.fileId;
      if (back) {
        h.setActive(back);
        h.focus(back);
      } else showFiles(h.activeId); // no file pane on screen (a pane that became a terminal): its files above
      return;
    }
    openFor(h.activeId);
  };

  /**
   * The terminal for file pane `id`: to the one it already has, else a new one below it, in its
   * folder where a shell can run there, else on this computer (FTP, a cloud, nothing open yet), so
   * a terminal is always one key or click away.
   */
  const openFor = (id: PaneId) => {
    const h = host.current;
    if (!h) return;
    const ts = termsRef.current;
    const mine = h.ids.find((x) => ts[x]?.from === id);
    if (mine) {
      h.setActive(mine);
      h.focus(mine);
      return;
    }
    const here = h.slot(id).here;
    if (here && canTerminal(profileOf(here.profileId))) open(id);
    else void openLocal(id);
  };

  /**
   * A terminal on this computer below pane `src` (the active one by default): in the folder a pane
   * of this computer shows, when one is open, else in the home folder. No file pane is needed first.
   */
  const localBusy = useRef(false);
  const openLocal = async (src?: PaneId, opts?: { reuse?: boolean }): Promise<PaneId | null> => {
    const h = host.current;
    if (!h || localBusy.current) return null;
    // a terminal on this computer is already open: go to it (the sidebar button is pressed again)
    const ts = termsRef.current;
    const there = opts?.reuse ? h.ids.find((x) => ts[x]?.profileId === LOCAL_PROFILE) : undefined;
    if (there) {
      h.setActive(there);
      h.focus(there);
      return there;
    }
    const mac = profileOf(LOCAL_PROFILE) ?? { id: LOCAL_PROFILE, kind: "local" as const };
    if (!canTerminal(mac)) {
      h.toast("info", `${terminalsWhere()}.`);
      return null;
    }
    const from = src ?? h.activeId;
    const shown = [from, ...h.ids].map((id) => h.slot(id).here).find((l) => l?.profileId === LOCAL_PROFILE);
    let at: Loc | null = shown ?? null;
    if (!at) {
      // one press at a time: a double click mustn't open two while the home folder is looked up
      localBusy.current = true;
      const home = (await api.listRoots(LOCAL_PROFILE).catch(() => []))[0]?.id;
      localBusy.current = false;
      if (home == null) {
        h.toast("info", "Couldn't find your home folder for the terminal.");
        return null;
      }
      at = { profileId: LOCAL_PROFILE, bucket: home, prefix: "" };
    }
    // the pane it was asked from may have closed meanwhile: below the active one then
    // (the host as it is now, after the wait)
    const now = host.current ?? h;
    return latest.current.open(now.ids.includes(from) ? from : now.activeId, at);
  };

  /**
   * An SSH connection opened: to its terminal when one is open (unless `another`), else a new one
   * below the active pane, in the server's start folder.
   */
  const openRemote = (profileId: string, another = false): PaneId | null => {
    const h = host.current;
    if (!h) return null;
    const ts = termsRef.current;
    const there = another ? undefined : h.ids.find((x) => ts[x]?.profileId === profileId);
    if (there) {
      h.setActive(there);
      h.focus(there);
      return there;
    }
    const at = { profileId, bucket: "", prefix: "" };
    // a file pane becomes the terminal, as it would show another connection's files (its files
    // are a click away: Folders); a terminal stays, with this one below it
    if (another || ts[h.activeId] || !canTerminal(profileOf(profileId))) return open(h.activeId, at);
    return shellIn(h.activeId, profileId);
  };

  /** File pane `id` becomes a terminal on server `profileId`, in its start folder. */
  const shellIn = (id: PaneId, profileId: string): PaneId => {
    const sid = newSid();
    focusWhenShown(sid);
    // its file side is put away as a workspace's terminal pane has it: no Back / Forward behind it
    const p = host.current?.slot(id);
    p?.closeQuick();
    p?.ent.setQuery("");
    p?.showConnection(null);
    p?.history.load(null, null);
    setTerms((cur) => {
      const next = { ...cur, [id]: { profileId, bucket: "", prefix: "", sid } };
      // a terminal that followed this pane has nothing to follow now
      for (const [k, t] of Object.entries(next)) if (t && k !== id && t.from === id && t.follow) next[k as PaneId] = { ...t, follow: false };
      return next;
    });
    return id;
  };

  /** The connection badge in a terminal's header: pane `id` gets a new shell on `profileId` (this computer: in the home folder). */
  const switchTo = async (id: PaneId, profileId: string) => {
    // the terminal it replaces: another pick or a workspace switch meanwhile wins over this one
    const was = termsRef.current[id]?.sid;
    let at: Loc = { profileId, bucket: "", prefix: "" };
    if (profileId === LOCAL_PROFILE) {
      const home = (await api.listRoots(LOCAL_PROFILE).catch(() => []))[0]?.id;
      if (home == null) {
        host.current?.toast("info", "Couldn't find your home folder for the terminal.");
        return;
      }
      at = { profileId, bucket: home, prefix: "" };
    }
    if (!was || termsRef.current[id]?.sid !== was) return; // closed, switched again or another workspace meanwhile
    const sid = newSid();
    focusWhenShown(sid);
    assign(id, { ...at, sid });
  };

  /**
   * Folders in a terminal's header: its file pane when that is on screen, else one above it, in
   * the connection and folder the terminal started in (⌘J then goes back and forth between them).
   */
  const showFiles = (id: PaneId) => {
    const h = host.current;
    const t = termsRef.current[id];
    if (!h || !t) return;
    const linked = t.from && h.ids.includes(t.from) && !termsRef.current[t.from] && h.slot(t.from).profile?.id === t.profileId ? t.from : null;
    if (linked) {
      h.setActive(linked);
      h.focus(linked);
      return;
    }
    const p = profileOf(t.profileId);
    if (!p) return;
    h.splitAbove(id, (fresh) => {
      h.slot(fresh).openBucket(p, t.bucket, t.prefix);
      setTerms((cur) => (cur[id] ? { ...cur, [id]: { ...cur[id]!, from: fresh } } : cur));
    });
  };

  /** "Open terminal here" / "Open in terminal" for folder `key` of file pane `id`'s root; none where a terminal can't open. */
  const items = (id: PaneId, key: string, label = "Open terminal here"): MenuItem[] => {
    const p = host.current?.slot(id);
    if (!p?.here || !canTerminal(p.profile)) return [];
    const at = { ...p.here, prefix: key };
    return [{ type: "item", label, icon: "terminal", hint: label === "Open terminal here" ? "⌘J" : undefined, onClick: () => void open(id, at) }];
  };

  /** Files dropped on terminal pane `pane`: what it does (undefined: not a terminal; null: these can't go there). */
  const dropTarget = (pane: PaneId, from: Place, items: Entry[]): string | null | undefined => {
    const t = termsRef.current[pane];
    if (!t) return undefined;
    if (from.profileId !== t.profileId) return null;
    if (t.profileId !== LOCAL_PROFILE && terminalRemoteBase(t.sid) == null) return null;
    return items.length === 1 ? "Paste its path in the terminal" : `Paste ${items.length} paths in the terminal`;
  };
  /** Types the dropped items' paths into the terminal, quoted for the shell. */
  const drop = async (pane: PaneId, from: Place, items: Entry[]) => {
    const t = termsRef.current[pane];
    if (!t) return;
    let quoted: (string | null)[];
    if (t.profileId === LOCAL_PROFILE) {
      const got = await Promise.all(items.map((e) => api.localPath(from.profileId, from.bucket, e.key.replace(/\/+$/, "")).catch(() => null)));
      const q = terminalQuoting(t.sid);
      if (!q) return host.current?.toast("info", "The terminal is still starting. Drop it again in a moment.");
      quoted = got.filter((p): p is string => !!p).map((p) => quoteAs(q, p));
    } else {
      const base = terminalRemoteBase(t.sid);
      if (base == null) return;
      quoted = items.map((e) => remotePath(base, e.key));
    }
    // names with control characters would act as keys (or end the bracketed paste): left out
    const paths = quoted.filter((p): p is string => p != null);
    if (paths.length < quoted.length) {
      host.current?.toast("info", paths.length ? CANT_TYPE_SOME : CANT_TYPE);
    }
    if (!paths.length) return;
    const why = termWriteWhy(writeToTerminal(pane, `${paths.join(" ")} `));
    if (why) return host.current?.toast("info", why);
    host.current?.setActive(pane);
    host.current?.focus(pane);
  };

  /**
   * Files dragged in from Finder / Explorer and dropped on terminal pane `pane`: their paths typed
   * in, quoted for the shell (never an upload). Undefined: not a terminal; a string: why not.
   */
  const dropPaths = (pane: PaneId, paths: string[]): string | null | undefined => {
    const t = termsRef.current[pane];
    if (!t) return undefined;
    if (t.profileId !== LOCAL_PROFILE) return REMOTE_TERM_DROP;
    const q = terminalQuoting(t.sid);
    if (!q) return "The terminal is still starting. Drop it again in a moment.";
    const quoted = paths.map((p) => quoteAs(q, p)).filter((p): p is string => p != null);
    if (!quoted.length) return CANT_TYPE;
    if (quoted.length < paths.length) host.current?.toast("info", CANT_TYPE_SOME);
    const why = termWriteWhy(writeToTerminal(pane, `${quoted.join(" ")} `));
    if (why) return why;
    host.current?.setActive(pane);
    host.current?.focus(pane);
    return null;
  };

  /** What a terminal pane is called (the drag ghost, the pane switcher). */
  const nameOf = (id: PaneId): string | null => {
    const t = termsRef.current[id];
    if (!t) return null;
    return `Terminal · ${t.prefix ? baseName(t.prefix) : profileOf(t.profileId)?.name || "Terminal"}`;
  };

  /** Connection `profileId` was deleted: its terminal panes go back to (empty) file panes. */
  const forget = (profileId: string) => {
    for (const [id, t] of Object.entries(termsRef.current)) if (t?.profileId === profileId) assign(id as PaneId, undefined);
  };

  /** Ends the shells of terminal panes no workspace has any more (closed, or their workspace closed). */
  const gc = (ws: WorkspaceStore) => {
    const keep = new Set<string>();
    for (const t of Object.values(termsRef.current)) if (t) keep.add(t.sid);
    for (const w of ws.list) if (w.id !== ws.active) for (const p of Object.values(w.panes)) if (p?.term?.sid) keep.add(p.term.sid);
    gcTerminals(keep);
  };

  /** Draws terminal pane `id`. */
  const render = (
    id: PaneId,
    o: { style?: CSSProperties; active: boolean; dual: boolean; lifted?: boolean; onGrip?: (e: React.PointerEvent<HTMLElement>) => void; drop?: "paste" | "refuse" | null },
  ) => {
    const t = termsRef.current[id]!;
    const h = host.current!;
    const prof = profileOf(t.profileId);
    const sub = t.prefix.replace(/\/+$/, "");
    // this computer: the real folder (a root's id is its path); a server: its folder as the sidebar names it
    const path =
      t.profileId === LOCAL_PROFILE
        ? [t.bucket.replace(/\/+$/, ""), sub].filter(Boolean).join("/") || "/"
        : prof?.net && !t.bucket
          ? // a server with one root: its start folder, not the connection's name a second time
            [(prof.net.basePath || "~").replace(/\/+$/, ""), sub].filter(Boolean).join("/") || "/"
          : [h.rootLabel(t.profileId, t.bucket) || t.bucket, sub].filter(Boolean).join("/") || "/";
    return (
      <TerminalSlot
        key={t.sid}
        id={id}
        spec={t}
        connName={prof?.name ?? "Terminal"}
        path={path}
        active={o.active}
        dual={o.dual}
        lifted={o.lifted}
        drop={o.drop ?? null}
        style={o.style}
        onGrip={o.onGrip}
        onActivate={() => {
          if (host.current?.activeId !== id) host.current?.setActive(id);
        }}
        onClose={() => host.current?.close(id)}
        onToggle={toggle}
        onFolders={() => showFiles(id)}
        onSwitch={(x, y) => h.connMenu(id, x, y, t.profileId, (pid) => void switchTo(id, pid))}
        follow={!!t.follow}
        canFollow={!!t.from && h.ids.includes(t.from) && !termsRef.current[t.from]}
        onFollow={() => setFollow(id, !t.follow)}
        note={t.follow ? (notes[t.sid] ?? null) : null}
        menu={h.menu}
        paneItems={() => h.paneItems(id)}
      />
    );
  };

  // the hooks for later features (api.ts) and the command palette
  const openLocalRef = useRef(openLocal);
  openLocalRef.current = openLocal;
  const latest = useRef({ open, toggle });
  latest.current = { open, toggle };
  useEffect(() => {
    setTerminalOpener(({ paneId, profileId, cwd, bucket, startup }) => {
      const p = host.current?.slot(paneId);
      const root = bucket ?? (p?.here?.profileId === profileId ? p.here.bucket : "");
      return latest.current.open(paneId, { profileId, bucket: root, prefix: cwd }, startup);
    });
    const off = registerCommands("terminal", () => {
      const h = host.current;
      if (!h) return [];
      const src = h.fileId ? h.slot(h.fileId) : null;
      const why = !src?.here ? "Open a folder first" : !canTerminal(src.profile) ? terminalsWhere() : null;
      const mac = profileOf(LOCAL_PROFILE) ?? { id: LOCAL_PROFILE, kind: "local" as const };
      return [
        { id: "terminal:here", title: "Open Terminal Here", group: "Terminal", icon: "terminal", keywords: "shell console command line ssh", disabled: why, run: () => void (h.fileId && latest.current.open(h.fileId)) },
        { id: "terminal:toggle", title: "Toggle Terminal", group: "Terminal", icon: "terminal", shortcut: "⌘J", keywords: "shell console focus ctrl backtick", run: () => latest.current.toggle() },
        {
          id: "terminal:new-local",
          title: `New Terminal on ${ON_OS.device}`,
          group: "Terminal",
          icon: "terminal",
          keywords: "shell console home",
          hidden: !canTerminal(mac),
          run: () => void openLocalRef.current(),
        },
        {
          id: "terminal:paste-ask",
          title: "Always Ask Before Pasting Several Lines",
          group: "Terminal",
          icon: "terminal",
          keywords: "paste confirm multi-line bracketed",
          hidden: !pasteTrustCount(),
          run: () => {
            askBeforeEveryPaste();
            h.toast("info", "Kybl asks again before pasting several lines.");
          },
        },
      ];
    });
    return () => {
      off();
      setTerminalOpener(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { terms, setTerms, assign, host, open, openLocal, openFor, openRemote, shellIn, forget, toggle, items, dropTarget, drop, dropPaths, nameOf, gc, render };
}

/**
 * The question before a paste with line breaks (see `pasteNeedsConfirm`): the text as it will be
 * typed, invisible characters and every line break shown. A big paste shows its start and end with
 * what's between counted, so the window never has to lay out megabytes; the line count and the list
 * of invisible characters always cover all of it. `choice.trust` is set when the user ticks "Don't
 * ask again in this terminal" (offered only while its shell has bracketed paste on).
 */
function pasteDialog({ text, canTrust }: PasteAsk, choice: { trust: boolean }): ConfirmOptions {
  const v = pasteView(text);
  const n = (x: number) => x.toLocaleString();
  const big = text.length > PASTE_ASK_ALWAYS;
  return {
    title: v.lines > 1 ? `Paste ${n(v.lines)} lines?` : big ? `Paste ${n(text.length)} characters?` : "Paste and run?",
    message: (
      <>
        <p>Some shells run each line as soon as it is pasted. Check the text first: a copy from a web page can hold lines you didn’t see.</p>
        {v.hidden.length > 0 && (
          <p className="paste-hidden">
            Hidden characters, shown as {"<U+…>"}: {v.hidden.slice(0, 6).map(([c, k]) => (k > 1 ? `${c} ×${n(k)}` : c)).join(", ")}
            {v.hidden.length > 6 ? ` and ${v.hidden.length - 6} more kinds` : ""}.
          </p>
        )}
        <pre className="toast-detail paste-preview selectable">
          {v.head}
          {v.cutChars > 0 && (
            <span className="paste-cut">
              {"\n… "}
              {n(v.cutChars)} more characters{v.cutLines ? `, ${n(v.cutLines)} line breaks` : ""} not shown{" …\n"}
            </span>
          )}
          {v.tail}
        </pre>
        {canTrust && (
          <label className="check paste-trust">
            <input type="checkbox" onChange={(e) => (choice.trust = e.target.checked)} />
            <span>Don’t ask again in this terminal</span>
          </label>
        )}
      </>
    ),
    label: "Paste",
  };
}
