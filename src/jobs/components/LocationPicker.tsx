/**
 * A folder tree across every connection and this device: connection → root (bucket, drive,
 * folder) → folders, loaded as they are opened. Used to pick where a copy or move goes.
 */
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { api, errMessage, errSummary, LOCAL_ID, type RootInfo } from "../../core/api";
import { Icon } from "../../ui/components/Icons";
import { FileIcon } from "../../browser/components/list/FileIcon";
import { deviceIcon, rootIcon } from "../../connections/lib/roots";
import { ProviderBadge } from "../../sidebar/Sidebar";
import { groupKeysHolding, organize, type OrgGroup } from "../../connections/lib/organize";
import { capsFor, forgetCaps } from "../../core/useCaps";
import { ConnFixButton, connTrouble, trustOnProfile, trustSaved } from "../../connections/components/ConnFix";
import type { Profile } from "../../core/types";
import { ON_OS } from "../../core/osNames";
import { nameProblem } from "../../connections/lib/itemText";
import "./jobs.css";

/** A folder somewhere: `dir` is "" for the top of the root, else ends with "/". */
export type Loc = { profileId: string; root: string; dir: string };
/** A picked folder with the names to show for it. */
export type PickedLocation = Loc & { connectionName: string; rootName: string };

/**
 * A folder name typed in the "new folder" field and not created yet. A dialog's main button
 * (marked `data-new-folder="commit"`) awaits `commit()` before it goes on: the new folder's place,
 * null when no name is pending, or false when it couldn't be created (the field says why). A
 * button marked `data-new-folder="cancel"` drops the name instead of creating it.
 */
export type NewFolderCommit = { commit: () => Promise<PickedLocation | null | false> };

/** How this device is called: "This Mac", "This PC", and on phones "On this phone" like their home screen. */
export function deviceName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  // iPadOS asks for the desktop site: a Mac with a touch screen is an iPad
  if (/iPad/i.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1)) return "On this iPad";
  if (/Android|iPhone|iPod/i.test(ua) || new URLSearchParams(location.search).has("mobile")) return "On this phone";
  return ON_OS.device;
}

/** A folder path for people: "media-prod / photos / 2026". */
export function locLabel(p: Pick<PickedLocation, "connectionName" | "rootName" | "dir">, withConnection = true): string {
  const parts = [p.rootName, ...p.dir.split("/").filter(Boolean)];
  if (withConnection) parts.unshift(p.connectionName);
  return parts.join(" / ");
}

type ConnData = { status: "loading" | "ready" | "error"; roots: RootInfo[]; single: boolean; error?: string };
type DirData = { status: "loading" | "ready" | "error"; folders: string[]; token: string | null; more?: boolean; error?: string };

type Row =
  | { type: "group"; key: string; depth: number; name: string; count: number }
  | { type: "conn"; key: string; depth: number; pid: string; name: string; provider?: string }
  | { type: "root"; key: string; depth: number; loc: Loc; name: string; rootKind: RootInfo["kind"] }
  | { type: "dir"; key: string; depth: number; loc: Loc; name: string }
  | { type: "state"; key: string; depth: number; text: string; error?: string; retry?: () => void; spin?: boolean; pid?: string }
  | { type: "more"; key: string; depth: number; loc: Loc }
  | { type: "new"; key: string; depth: number; loc: Loc };

const connKey = (pid: string) => `c\n${pid}`;
const groupKey = (key: string) => `g\n${key}`;
const dirKey = (l: Loc) => `d\n${l.profileId}\n${l.root}\n${l.dir}`;
const sortNames = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
const nameOf = (dir: string) => dir.replace(/\/$/, "").split("/").pop() ?? dir;

function DeviceIcon() {
  return (
    <span className="jobs-device" aria-hidden="true">
      <Icon name={deviceIcon} size={15} />
    </span>
  );
}

export function LocationPicker({
  value,
  onChange,
  blocked,
  creating = false,
  onCreatingDone,
  commitRef,
  className = "",
}: {
  value: Loc | null;
  onChange: (picked: PickedLocation) => void;
  /** why a folder can't be picked (e.g. it is the source itself), or null */
  blocked?: (loc: Loc) => string | null;
  /** show a "new folder" field inside the picked folder */
  creating?: boolean;
  onCreatingDone?: () => void;
  /** lets the dialog's main button create a typed folder name first (see `NewFolderCommit`) */
  commitRef?: React.Ref<NewFolderCommit>;
  className?: string;
}) {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const conns = useRef(new Map<string, ConnData>());
  const dirs = useRef(new Map<string, DirData>());
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>();
    if (value) {
      s.add(connKey(value.profileId));
      const parts = value.dir.split("/").filter(Boolean);
      for (let i = 0; i < parts.length; i++) s.add(dirKey({ ...value, dir: parts.slice(0, i).map((p) => p + "/").join("") }));
      // and the folder itself, so its subfolders (the likely destinations) show at once
      s.add(dirKey(value));
    }
    return s;
  });
  const [newName, setNewName] = useState("");
  const [newError, setNewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    let live = true;
    api
      .listProfiles()
      .then((p) => live && setProfiles(p))
      .catch((e) => {
        if (!live) return;
        setProfiles([]);
        setProfilesError(errSummary(errMessage(e)));
      });
    return () => {
      live = false;
    };
  }, []);

  const connections = useMemo(
    () => [
      // this device is listed once, last, under its own name (a backend may list it as a profile too)
      ...(profiles ?? []).filter((p) => p.id !== LOCAL_ID && p.kind !== "local").map((p) => ({ pid: p.id, name: p.name || p.endpoint, provider: p.provider })),
      { pid: LOCAL_ID, name: deviceName(), provider: undefined },
    ],
    [profiles],
  );
  const layout = useMemo(() => organize((profiles ?? []).filter((p) => p.id !== LOCAL_ID && p.kind !== "local"), { recentAfter: Infinity }), [profiles]);
  // the group holding the starting connection folds open once the connections are known
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !value || !profiles) return;
    opened.current = true;
    const keys = groupKeysHolding(layout.groups, value.profileId).map(groupKey);
    if (keys.length) setExpanded((s) => new Set([...s, ...keys]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);
  const connName = (pid: string) => connections.find((c) => c.pid === pid)?.name ?? pid;
  const rootName = (pid: string, root: string) => conns.current.get(pid)?.roots.find((r) => r.id === root)?.name ?? root;

  const loadConn = (pid: string) => {
    conns.current.set(pid, { status: "loading", roots: [], single: false });
    bump();
    Promise.all([api.listRoots(pid), capsFor(pid).catch(() => null)])
      .then(([roots, caps]) => {
        conns.current.set(pid, { status: "ready", roots, single: caps?.roots === "single" && roots.length === 1 });
        // the picked root's name only became known now
        const v = valueRef.current;
        if (v && v.profileId === pid) {
          const r = roots.find((x) => x.id === v.root);
          if (r) onChangeRef.current({ ...v, connectionName: connName(pid), rootName: r.name });
        }
      })
      .catch((e) => conns.current.set(pid, { status: "error", roots: [], single: false, error: errMessage(e) }))
      .finally(bump);
  };

  const loadDir = async (loc: Loc, append = false) => {
    const key = dirKey(loc);
    const prev = dirs.current.get(key);
    if (append && prev) dirs.current.set(key, { ...prev, more: true });
    else dirs.current.set(key, { status: "loading", folders: [], token: null });
    bump();
    try {
      const r = await api.listObjects(loc.profileId, loc.root, loc.dir, append ? prev?.token : null);
      const have = append && prev ? prev.folders : [];
      const folders = [...new Set([...have, ...r.folders])].sort(sortNames);
      dirs.current.set(key, { status: "ready", folders, token: r.nextToken });
    } catch (e) {
      dirs.current.set(key, { status: "error", folders: [], token: null, error: errMessage(e) });
    }
    bump();
  };

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // the rows on screen, with what still has to load
  const toLoad: Array<() => void> = [];
  const rows: Row[] = [];
  const addDir = (loc: Loc, depth: number) => {
    const key = dirKey(loc);
    const d = dirs.current.get(key);
    if (!d) {
      toLoad.push(() => void loadDir(loc));
      rows.push({ type: "state", key: `${key}\nload`, depth, text: "Loading folders…", spin: true });
      return;
    }
    if (creating && value && dirKey(value) === key) rows.push({ type: "new", key: `${key}\nnew`, depth, loc });
    if (d.status === "loading") rows.push({ type: "state", key: `${key}\nload`, depth, text: "Loading folders…", spin: true });
    if (d.status === "error") rows.push({ type: "state", key: `${key}\nerr`, depth, text: "Couldn't list the folders here.", error: d.error, retry: () => void loadDir(loc), pid: loc.profileId });
    for (const f of d.folders) {
      const child = { ...loc, dir: f };
      const ck = dirKey(child);
      rows.push({ type: "dir", key: ck, depth, loc: child, name: nameOf(f) });
      if (expanded.has(ck)) addDir(child, depth + 1);
    }
    if (d.token) rows.push({ type: "more", key: `${key}\nmore`, depth, loc });
  };
  const addConn = (c: { pid: string; name: string; provider?: string }, cd: number) => {
    const ck = connKey(c.pid);
    rows.push({ type: "conn", key: ck, depth: cd, pid: c.pid, name: c.name, provider: c.provider });
    if (!expanded.has(ck)) return;
    const data = conns.current.get(c.pid);
    if (!data) {
      toLoad.push(() => loadConn(c.pid));
      rows.push({ type: "state", key: `${ck}\nload`, depth: cd + 1, text: "Loading…", spin: true });
      return;
    }
    if (data.status === "loading") rows.push({ type: "state", key: `${ck}\nload`, depth: cd + 1, text: "Loading…", spin: true });
    else if (data.status === "error") rows.push({ type: "state", key: `${ck}\nerr`, depth: cd + 1, text: "Couldn't open this connection.", error: data.error, retry: () => loadConn(c.pid), pid: c.pid });
    else if (data.roots.length === 0) rows.push({ type: "state", key: `${ck}\nnone`, depth: cd + 1, text: "Nothing here yet." });
    else if (data.single) addDir({ profileId: c.pid, root: data.roots[0].id, dir: "" }, cd + 1);
    else
      for (const r of data.roots) {
        const loc = { profileId: c.pid, root: r.id, dir: "" };
        const rk = dirKey(loc);
        rows.push({ type: "root", key: rk, depth: cd + 1, loc, name: r.name, rootKind: r.kind });
        if (expanded.has(rk)) addDir(loc, cd + 2);
      }
  };
  // the organizing model (connections/organize.ts): pinned first (and again in their group, like the
  // desktop sidebar, so a group's count matches its rows), then groups as folders (a long
  // ungrouped list sorted by type), then the rest, this device last
  const asConn = (p: Profile) => ({ pid: p.id, name: p.name || p.endpoint, provider: p.provider });
  const addGroup = (g: OrgGroup, d: number) => {
    const gk = groupKey(g.key);
    rows.push({ type: "group", key: gk, depth: d, name: g.name, count: g.count });
    if (!expanded.has(gk)) return;
    for (const sub of g.groups) addGroup(sub, d + 1);
    for (const p of g.items) addConn(asConn(p), d + 1);
  };
  for (const p of layout.pinned) addConn(asConn(p), 0);
  for (const g of layout.groups) addGroup(g, 0);
  for (const p of layout.items) addConn(asConn(p), 0);
  addConn({ pid: LOCAL_ID, name: deviceName(), provider: undefined }, 0);

  useEffect(() => {
    for (const run of toLoad) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  // a new-folder field opens the folder it goes in
  useEffect(() => {
    if (!creating || !value) return;
    setNewName("");
    setNewError(null);
    const d = conns.current.get(value.profileId);
    setExpanded((s) => {
      const n = new Set(s);
      n.add(connKey(value.profileId));
      if (value.dir || !d?.single) n.add(dirKey(value));
      return n;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creating]);

  const selectedKey = value ? (value.dir === "" && conns.current.get(value.profileId)?.single ? connKey(value.profileId) : dirKey(value)) : null;

  // the starting folder may be deep in the tree: show it once its row is there
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !selectedKey) return;
    const el = listRef.current?.querySelector(`[data-key="${CSS.escape(selectedKey)}"]`);
    if (el) {
      scrolled.current = true;
      el.scrollIntoView({ block: "nearest" });
    }
  });

  const pick = (loc: Loc) => {
    if (blocked?.(loc)) return;
    onChange({ ...loc, connectionName: connName(loc.profileId), rootName: rootName(loc.profileId, loc.root) });
  };
  const rowLoc = (r: Row): Loc | null => {
    if (r.type === "root" || r.type === "dir") return r.loc;
    if (r.type === "conn") {
      const d = conns.current.get(r.pid);
      return d?.single ? { profileId: r.pid, root: d.roots[0].id, dir: "" } : null;
    }
    return null;
  };
  const toggle = (key: string, open?: boolean) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (open ?? !n.has(key)) n.add(key);
      else n.delete(key);
      return n;
    });
  const onRow = (r: Row) => {
    const loc = rowLoc(r);
    const no = !loc || !!blocked?.(loc);
    if (!no) pick(loc);
    // a click on the picked row (or one that can't be picked, like the source's own folder) opens
    // or closes it; on another row it picks and opens it
    if (r.key === selectedKey || no) toggle(r.key);
    else toggle(r.key, true);
  };

  // one creation at a time: the field's Enter, its blur and a dialog's main button share it
  const inFlight = useRef<Promise<PickedLocation | null | false> | null>(null);
  const createFolder = (): Promise<PickedLocation | null | false> => {
    if (inFlight.current) return inFlight.current;
    const run = async (): Promise<PickedLocation | null | false> => {
      if (!value) return null;
      const name = newName.trim().replace(/\/+$/, "");
      if (!name) {
        onCreatingDone?.();
        return null;
      }
      const bad = nameProblem(name);
      if (bad) {
        setNewError(bad);
        return false;
      }
      const dir = `${value.dir}${name}/`;
      setBusy(true);
      try {
        await api.createFolder(value.profileId, value.root, dir);
        const key = dirKey(value);
        const d = dirs.current.get(key);
        dirs.current.set(key, { status: "ready", token: d?.token ?? null, folders: [...new Set([...(d?.folders ?? []), dir])].sort(sortNames) });
        setNewName("");
        onCreatingDone?.();
        const loc = { ...value, dir };
        pick(loc);
        return { ...loc, connectionName: connName(loc.profileId), rootName: rootName(loc.profileId, loc.root) };
      } catch (e) {
        setNewError(errSummary(errMessage(e)));
        return false;
      } finally {
        setBusy(false);
      }
    };
    const p = run().finally(() => {
      inFlight.current = null;
    });
    inFlight.current = p;
    return p;
  };
  const pendingName = creating && !!value && !!newName.trim();
  useImperativeHandle(commitRef, () => ({ commit: () => (pendingName || inFlight.current ? createFolder() : Promise.resolve(null)) }));

  // what the pointer went down on, read when the field loses focus (WebKit doesn't focus a
  // clicked button, so the blur's relatedTarget can't say)
  const pressed = useRef<Element | null>(null);
  useEffect(() => {
    if (!creating) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const down = (e: PointerEvent) => {
      // an earlier press's timer must not forget this one
      clearTimeout(timer);
      pressed.current = e.target instanceof Element ? e.target : null;
    };
    // a press only explains the blur it causes, so it is forgotten soon after: a later Tab away
    // would otherwise be read as the click it no longer is. Not at pointerup itself: on touch the
    // blur comes after it (pointerup, touchend, then the compatibility mousedown moves focus)
    const up = () => {
      clearTimeout(timer);
      timer = setTimeout(() => (pressed.current = null), 400);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
    };
  }, [creating]);
  const onNewBlur = (e: React.FocusEvent) => {
    const to = pressed.current ?? (e.relatedTarget instanceof Element ? e.relatedTarget : null);
    pressed.current = null;
    const role = to?.closest("[data-new-folder]")?.getAttribute("data-new-folder");
    // the main button creates it and then goes on
    if (role === "commit") return;
    // Cancel, or another folder picked in the tree: the typed name is dropped
    if (role === "cancel" || (to && listRef.current?.contains(to))) return onCreatingDone?.();
    if (newName.trim()) void createFolder();
    else onCreatingDone?.();
  };

  /** The trust button for a row's error (a server's own certificate, an SFTP key, plain FTP), or nothing. */
  const fixFor = (r: Extract<Row, { type: "state" }>) => {
    const p = r.pid ? profiles?.find((x) => x.id === r.pid) : undefined;
    const trouble = p && r.retry ? connTrouble(p, r.error) : null;
    if (!p || !trouble || !r.retry) return null;
    const again = r.retry;
    const saved = (np: Profile) => {
      forgetCaps(np.id);
      setProfiles((ps) => ps && ps.map((x) => (x.id === np.id ? np : x)));
      trustSaved(np);
      again();
    };
    return (
      <ConnFixButton
        trouble={trouble}
        className={trouble.kind === "plain" ? "btn btn-sm" : "btn btn-primary btn-sm"}
        onTrustCert={async (fp) => saved(await trustOnProfile(p, { certFingerprint: fp }))}
        onTrustHostKey={async (fp) => saved(await trustOnProfile(p, { hostKey: fp }))}
        onAllowPlain={async () => {
          if (p.net) await api.ftpAllowPlain(p.net);
          forgetCaps(p.id);
          again();
        }}
      />
    );
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const nav = rows.filter((r) => r.type === "group" || r.type === "conn" || r.type === "root" || r.type === "dir");
    const i = nav.findIndex((r) => r.key === selectedKey);
    const cur = nav[i];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      for (let j = i + step; j >= 0 && j < nav.length; j += step) {
        const loc = rowLoc(nav[j]);
        if (loc && !blocked?.(loc)) {
          pick(loc);
          listRef.current?.querySelector(`[data-key="${CSS.escape(nav[j].key)}"]`)?.scrollIntoView({ block: "nearest" });
          break;
        }
        if (!loc && (nav[j].type === "conn" || nav[j].type === "group")) {
          // a connection with several roots isn't a place itself: open it on the way past
          toggle(nav[j].key, true);
        }
      }
    } else if (cur && (e.key === "ArrowRight" || e.key === "Enter")) {
      e.preventDefault();
      toggle(cur.key, true);
    } else if (cur && e.key === "ArrowLeft") {
      e.preventDefault();
      if (expanded.has(cur.key)) toggle(cur.key, false);
      else if (value && value.dir) pick({ ...value, dir: value.dir.replace(/[^/]+\/$/, "") });
    }
  };

  return (
    <div className={`jobs-tree ${className}`} ref={listRef} role="tree" aria-label="Destination" tabIndex={0} onKeyDown={onKey}>
      {profiles === null && (
        <div className="jobs-tree-state">
          <span className="spinner" /> Loading connections…
        </div>
      )}
      {profilesError && <div className="jobs-tree-state error">{profilesError}</div>}
      {profiles !== null &&
        rows.map((r) => {
          const pad = { paddingLeft: 8 + r.depth * 16 };
          if (r.type === "state") {
            const fix = fixFor(r);
            return (
              <div key={r.key} className={`jobs-tree-state ${r.error ? "error" : ""}`} style={pad}>
                {r.spin && <span className="spinner" />}
                <span>{r.text}</span>
                {r.error && <span className="jobs-tree-detail" title={r.error}>{errSummary(r.error)}</span>}
                {fix}
                {r.retry && (
                  <button className="btn btn-ghost btn-sm" onClick={r.retry}>
                    Try again
                  </button>
                )}
              </div>
            );
          }
          if (r.type === "more") {
            const d = dirs.current.get(dirKey(r.loc));
            return (
              <button key={r.key} className="jobs-tree-row more" style={pad} disabled={d?.more} onClick={() => void loadDir(r.loc, true)}>
                <span className="jobs-tree-caret" />
                {d?.more ? <span className="spinner" /> : <Icon name="chevron-down" size={13} />}
                <span className="jobs-tree-name">Show more folders</span>
              </button>
            );
          }
          if (r.type === "new")
            return (
              <div key={r.key} className="jobs-tree-row new" style={pad}>
                <span className="jobs-tree-caret" />
                <FileIcon entry={{ kind: "folder", key: "_", name: "", size: 0, modified: null }} size={16} />
                <input
                  autoFocus
                  value={newName}
                  disabled={busy}
                  placeholder="Folder name"
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  enterKeyHint="done"
                  onChange={(e) => {
                    setNewName(e.target.value);
                    setNewError(null);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") void createFolder();
                    if (e.key === "Escape") onCreatingDone?.();
                  }}
                  onBlur={onNewBlur}
                />
                {newError && <span className="jobs-tree-detail error">{newError}</span>}
              </div>
            );
          const loc = rowLoc(r);
          const why = loc ? blocked?.(loc) : null;
          const open = expanded.has(r.key);
          const selected = r.key === selectedKey;
          return (
            <button
              key={r.key}
              data-key={r.key}
              className={`jobs-tree-row ${r.type} ${selected ? "selected" : ""} ${why ? "blocked" : ""}`}
              style={pad}
              aria-disabled={!!why}
              title={why ?? undefined}
              role="treeitem"
              aria-selected={selected}
              aria-expanded={open}
              onClick={() => onRow(r)}
            >
              <span
                className={`jobs-tree-caret ${open ? "open" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(r.key);
                }}
              >
                <Icon name="chevron" size={11} />
              </span>
              {r.type === "group" && <Icon name="folder" size={15} className="jobs-tree-icon" />}
              {r.type === "conn" && (r.pid === LOCAL_ID ? <DeviceIcon /> : <ProviderBadge provider={r.provider} />)}
              {r.type === "root" && <Icon name={rootIcon(r.loc.profileId, r.loc.root)} size={15} className="jobs-tree-icon" />}
              {r.type === "dir" && <FileIcon entry={{ kind: "folder", key: r.loc.dir, name: r.name, size: 0, modified: null }} size={16} />}
              <span className="jobs-tree-name">{r.name}</span>
              {r.type === "group" && <span className="jobs-tree-detail">{r.count}</span>}
              {selected && <Icon name="check" size={13} className="jobs-tree-check" />}
            </button>
          );
        })}
    </div>
  );
}
