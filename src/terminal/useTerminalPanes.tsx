/**
 * The shell's side of terminal panes: which pane slots show a terminal (and in which folder), the
 * ways to open one (⌃`, the pane's ⋯ and folder menus, the command palette, `openTerminal`),
 * files dropped on one, following the folder of the pane it opened from, and ending the shells of
 * panes no workspace has any more.
 *
 * A terminal takes a pane slot like a file pane: the layout (paneLayout.ts) splits, drags, docks
 * and moves it the same way. Its slot's file pane sits idle, showing nothing, meanwhile.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../api";
import { baseName } from "../format";
import { LOCAL_PROFILE, type Loc, type PaneId } from "../browser/types";
import type { Pane } from "../browser/usePane";
import type { MenuItem } from "../components/Dialogs";
import type { ConfirmOptions, Dialogs } from "../shell/useDialogs";
import type { Place } from "../shell/crossPane";
import { leaves } from "../shell/paneLayout";
import type { Layout, WorkspaceStore } from "../shell/workspaces";
import { registerCommands } from "../palette/commands";
import type { Entry, Profile } from "../types";
import { TerminalSlot } from "./TerminalSlot";
import { pastePreview } from "./quote";
import { ON_OS } from "../osNames";
import {
  canTerminal,
  gcTerminals,
  newSid,
  remotePath,
  setStartup,
  focusWhenShown,
  setTerminalOpener,
  setTerminalPanes,
  pasteTrustsBracketed,
  setPasteConfirm,
  setPasteTrustsBracketed,
  shellQuote,
  terminalIdle,
  terminalRemoteBase,
  typeIntoTerminal,
  writeToTerminal,
  type TermPlace,
  type TermSpec,
} from "./api";

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
  setActive: (id: PaneId) => void;
  focus: (id: PaneId) => void;
  close: (id: PaneId) => void;
  confirm: Dialogs["confirm"];
  menu: Dialogs["menu"];
  toast: Dialogs["toast"];
  rootLabel: (profileId: string, root: string) => string;
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
    setPasteConfirm(async (text) => {
      const choice = { trust: false };
      const ok = (await host.current?.confirm(pasteDialog(text, choice))) ?? false;
      if (ok && choice.trust) setPasteTrustsBracketed(true);
      return ok;
    });
    return () => setPasteConfirm(null);
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
    let path: string | null = null;
    // a name with control characters would act as keys when typed: not followed
    let untypeable = false;
    if (t.profileId === LOCAL_PROFILE) {
      const p = await api.localPath(to.profileId, to.bucket, to.prefix.replace(/\/+$/, "")).catch(() => null);
      if (p) path = shellQuote(p);
      untypeable = !!p && path == null;
    } else {
      const base = terminalRemoteBase(t.sid);
      if (base != null) {
        path = remotePath(base, to.prefix);
        untypeable = path == null;
      }
    }
    if (untypeable && !stale()) return note(t.sid, "not following: the folder name has control characters");
    if (!path || stale()) return;
    for (let i = 0; ; i++) {
      if (await terminalIdle(t.sid)) break;
      if (stale()) return;
      if (i >= 6) return note(t.sid, "not following: busy");
      await new Promise((r) => setTimeout(r, 120));
    }
    if (stale() || !typeIntoTerminal(t.sid, ` cd ${path}\r`)) return;
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
      h.toast("info", `Terminals open on ${ON_OS.device} and on SFTP connections.`);
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

  /** ⌃`: from a file pane to its terminal (opening one below it the first time), from a terminal back to its file pane. */
  const toggle = () => {
    const h = host.current;
    if (!h) return;
    const ts = termsRef.current;
    const on = h.ids.filter((id) => ts[id]);
    const cur = ts[h.activeId];
    if (cur) {
      const back = cur.from && h.ids.includes(cur.from) && !ts[cur.from] ? cur.from : h.fileId;
      if (back) {
        h.setActive(back);
        h.focus(back);
      }
      return;
    }
    const mine = on.find((id) => ts[id]!.from === h.activeId);
    if (mine) {
      h.setActive(mine);
      h.focus(mine);
    } else open(h.activeId);
  };

  /** "Open terminal here" / "Open in terminal" for folder `key` of file pane `id`'s root; none where a terminal can't open. */
  const items = (id: PaneId, key: string, label = "Open terminal here"): MenuItem[] => {
    const p = host.current?.slot(id);
    if (!p?.here || !canTerminal(p.profile)) return [];
    const at = { ...p.here, prefix: key };
    return [{ type: "item", label, icon: "terminal", hint: label === "Open terminal here" ? "⌃`" : undefined, onClick: () => void open(id, at) }];
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
      quoted = got.filter((p): p is string => !!p).map(shellQuote);
    } else {
      const base = terminalRemoteBase(t.sid);
      if (base == null) return;
      quoted = items.map((e) => remotePath(base, e.key));
    }
    // names with control characters would act as keys (or end the bracketed paste): left out
    const paths = quoted.filter((p): p is string => p != null);
    if (paths.length < quoted.length) {
      host.current?.toast("info", paths.length ? "Names with control characters were left out." : "That name has control characters, so it isn't pasted into the terminal.");
    }
    if (paths.length && writeToTerminal(pane, `${paths.join(" ")} `)) {
      host.current?.setActive(pane);
      host.current?.focus(pane);
    }
  };

  /**
   * Files dragged in from Finder / Explorer and dropped on terminal pane `pane`: their paths typed
   * in, quoted for the shell (never an upload). Undefined: not a terminal; a string: why not.
   */
  const dropPaths = (pane: PaneId, paths: string[]): string | null | undefined => {
    const t = termsRef.current[pane];
    if (!t) return undefined;
    if (t.profileId !== LOCAL_PROFILE) return REMOTE_TERM_DROP;
    const quoted = paths.map(shellQuote).filter((p): p is string => p != null);
    if (!quoted.length) return "That name has control characters, so it isn't pasted into the terminal.";
    if (quoted.length < paths.length) host.current?.toast("info", "Names with control characters were left out.");
    if (writeToTerminal(pane, `${quoted.join(" ")} `)) {
      host.current?.setActive(pane);
      host.current?.focus(pane);
    }
    return null;
  };

  /** What a terminal pane is called (the drag ghost, the pane switcher). */
  const nameOf = (id: PaneId): string | null => {
    const t = termsRef.current[id];
    if (!t) return null;
    return `Terminal · ${t.prefix ? baseName(t.prefix) : profileOf(t.profileId)?.name || "Terminal"}`;
  };

  /** Ends the shells of terminal panes no workspace has any more (closed, or their workspace closed). */
  const gc = (ws: WorkspaceStore) => {
    const keep = new Set<string>();
    for (const t of Object.values(termsRef.current)) if (t) keep.add(t.sid);
    for (const w of ws.list) if (w.id !== ws.active) for (const p of Object.values(w.panes)) if (p?.term?.sid) keep.add(p.term.sid);
    gcTerminals(keep);
  };

  /** Draws terminal pane `id`. */
  const render = (id: PaneId, o: { style?: CSSProperties; active: boolean; dual: boolean; lifted?: boolean; onGrip?: (e: React.PointerEvent<HTMLElement>) => void }) => {
    const t = termsRef.current[id]!;
    const h = host.current!;
    const prof = profileOf(t.profileId);
    const sub = t.prefix.replace(/\/+$/, "");
    // this computer: the real folder (a root's id is its path); a server: its folder as the sidebar names it
    const path =
      t.profileId === LOCAL_PROFILE
        ? [t.bucket.replace(/\/+$/, ""), sub].filter(Boolean).join("/") || "/"
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
        style={o.style}
        onGrip={o.onGrip}
        onActivate={() => {
          if (host.current?.activeId !== id) host.current?.setActive(id);
        }}
        onClose={() => host.current?.close(id)}
        onToggle={toggle}
        follow={!!t.follow}
        canFollow={!!t.from && h.ids.includes(t.from) && !termsRef.current[t.from]}
        onFollow={() => setFollow(id, !t.follow)}
        note={t.follow ? (notes[t.sid] ?? null) : null}
        menu={h.menu}
      />
    );
  };

  // the hooks for later features (api.ts) and the command palette
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
      const why = !src?.here ? "Open a folder first" : !canTerminal(src.profile) ? `Terminals open on ${ON_OS.device} and on SFTP connections` : null;
      const mac = profileOf(LOCAL_PROFILE) ?? { id: LOCAL_PROFILE, kind: "local" as const };
      return [
        { id: "terminal:here", title: "Open Terminal Here", group: "Terminal", icon: "terminal", keywords: "shell console command line ssh", disabled: why, run: () => void (h.fileId && latest.current.open(h.fileId)) },
        { id: "terminal:toggle", title: "Toggle Terminal", group: "Terminal", icon: "terminal", shortcut: "⌃`", keywords: "shell console focus", run: () => latest.current.toggle() },
        {
          id: "terminal:new-local",
          title: `New Terminal on ${ON_OS.device}`,
          group: "Terminal",
          icon: "terminal",
          keywords: "shell console home",
          hidden: !canTerminal(mac),
          run: async () => {
            const home = (await api.listRoots(LOCAL_PROFILE).catch(() => []))[0]?.id;
            if (home != null) latest.current.open(host.current?.activeId ?? h.activeId, { profileId: LOCAL_PROFILE, bucket: home, prefix: "" });
          },
        },
        {
          id: "terminal:paste-ask",
          title: "Always Ask Before Pasting Several Lines",
          group: "Terminal",
          icon: "terminal",
          keywords: "paste confirm multi-line bracketed",
          hidden: !pasteTrustsBracketed(),
          run: () => {
            setPasteTrustsBracketed(false);
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

  return { terms, setTerms, assign, host, open, toggle, items, dropTarget, drop, dropPaths, nameOf, gc, render };
}

/**
 * The question before a paste with line breaks (see `pasteNeedsConfirm`): the whole text, as it
 * will be typed (scrolls, never cut), invisible characters shown. `choice.trust` is set when the
 * user ticks the box to skip it in shells that take a paste whole.
 */
function pasteDialog(text: string, choice: { trust: boolean }): ConfirmOptions {
  const lines = text.replace(/[\r\n]+$/, "").split(/\r\n|\r|\n/).length;
  return {
    title: lines > 1 ? `Paste ${lines} lines?` : "Paste and run?",
    message: (
      <>
        <p>Some shells run each line as soon as it is pasted. Check the text first: a copy from a web page can hold lines you didn’t see.</p>
        <pre className="toast-detail paste-preview selectable">{pastePreview(text)}</pre>
        <label className="check paste-trust">
          <input type="checkbox" onChange={(e) => (choice.trust = e.target.checked)} />
          <span>Don’t ask in shells that wait for Enter after a paste (zsh, bash 5.1+, fish)</span>
        </label>
      </>
    ),
    label: "Paste",
  };
}
