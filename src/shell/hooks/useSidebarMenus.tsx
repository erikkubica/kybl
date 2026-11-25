import { MountDialog } from "../../mount/MountDialog";
import type { ToastAction } from "../../desktop/components/fileOps";
import type { ConnDialogAsk } from "../lib/types";
import type { SettingsPageId } from "../../settings/SettingsPage";
import type { Pane } from "../../browser/hooks/usePane";
import { type PaneId, THIS_MAC } from "../../browser/types";
import { type Profile } from "../../core/types";
import { api, errSummary, errMessage, type MountInfo } from "../../core/api";
import { type Favorite } from "../../settings/settings";
import { type EmptyActions } from "../../browser/components/PaneEmpty";
import { trustOnProfile } from "../../connections/components/ConnFix";
import { forgetCaps, peekCaps } from "../../core/useCaps";
import { freshConnection } from "../../log/connLog";
import { scopeOf, revealKeys, type GroupChanges, normalizeGroup, groupOf, allGroups, groupLabel, inScope, renameGroup, renamedOpen, parentGroup, ungroup, type KindSection, type GroupNode, useOpenGroups, useRecentConnections } from "../../connections/lib/groups";
import { useEffect, type Dispatch, type SetStateAction } from "react";
import { isShellConn } from "../../connections/lib/kinds";
import { moveInto, togglePins } from "../../connections/lib/organize";
import { type MenuItem, type Toast } from "../../ui/components/Dialogs";
import { tidyMenu } from "../../desktop/lib/menus";
import { driveItems } from "../../mount/driveMenu";
import { findMount } from "../../mount/useMounts";
import { rootsMode, rootIcon } from "../../connections/lib/roots";
import { photoMenuItems } from "../components/photoMenu";
import { tunnelMenuItems } from "../../tunnels/tunnelMenu";
import { KYBL } from "../../connections/lib/kybl";
import { connectionMenuItems } from "../../connections/lib/organizeMenu";
import { useAuthNeeded } from "../../connections/lib/authNeeded";
import { useConnections } from "./useConnections";
import { useDialogs } from "./useDialogs";
import { useMigrationHost } from "./useMigrationHost";
import { useConnPicks } from "../../connections/hooks/useConnPicks";
import { useWorkspaceRecipes } from "./useWorkspaceRecipes";
import { useSidePeek } from "./useSidePeek";
import { useTerminalPanes } from "../../terminal/hooks/useTerminalPanes";

export interface UseSidebarMenusDeps {
  active: Pane;
  authNeeded: ReturnType<typeof useAuthNeeded>;
  connectIn: (id: PaneId, p: Profile, preferBucket?: string, startPrefix?: string) => Promise<void>;
  conns: ReturnType<typeof useConnections>;
  dialogs: ReturnType<typeof useDialogs>;
  fileId: PaneId;
  focusSoon: (id: PaneId) => number;
  migrations: ReturnType<typeof useMigrationHost>;
  mounts: MountInfo[];
  openGroups: ReturnType<typeof useOpenGroups>;
  openHere: (run: (pane: Pane) => void) => void;
  openSettings: (page?: SettingsPageId) => void;
  openShell: (p: Profile, another?: boolean) => void;
  paneById: (id: PaneId) => Pane;
  picks: ReturnType<typeof useConnPicks>;
  profiles: Profile[];
  rec: ReturnType<typeof useWorkspaceRecipes>;
  recents: ReturnType<typeof useRecentConnections>;
  saved: Profile[];
  setActiveId: (id: PaneId) => void;
  setConnDialog: (d: ConnDialogAsk | null) => void;
  setFindSignal: Dispatch<SetStateAction<number>>;
  setKyblDialog: Dispatch<SetStateAction<{ existing: Profile | null; reconnect?: boolean; } | null>>;
  showFilePane: () => void;
  sideHidden: boolean;
  sidePeek: ReturnType<typeof useSidePeek>;
  term: ReturnType<typeof useTerminalPanes>;
  toast: (kind: Toast["kind"], text: string, action?: ToastAction) => void;
  toggleConnection: (p: Profile) => void;
}

/** The sidebar's actions and right-click menus: connections, groups, buckets, drives, favorites and the folded rail. */
export function useSidebarMenus(h: UseSidebarMenusDeps) {
  /** Opens a bucket in the pane that asked (an empty pane), or from the sidebar where "open here" goes. */
  const openBucketIn = (id: PaneId | undefined, p: Profile, name: string) => {
    if (id != null) h.paneById(id).openBucket(p, name);
    else h.openHere((pane) => pane.openBucket(p, name));
  };
  const askBucketName = (p: Profile | null = h.active.profile, id?: PaneId) => {
    if (!p) return;
    h.dialogs.prompt({
      title: "Open bucket",
      label: `Bucket name in ${p.name}`,
      initial: "",
      confirmLabel: "Open",
      run: (name) => {
        h.conns.rememberBucket(p, name);
        openBucketIn(id, p, name);
      },
    });
  };

  /** Kybl Storage: the account owns its buckets, so it can make new ones. */
  const askNewBucket = (p: Profile | null = h.active.profile, id?: PaneId) => {
    if (!p) return;
    h.dialogs.prompt({
      title: "New bucket",
      label: `Bucket name in ${p.name}`,
      initial: "",
      confirmLabel: "Create",
      // a name the server refuses (taken, not allowed) shows in the dialog, with the name kept
      run: async (raw) => {
        const name = raw.trim();
        try {
          await api.createBucket(p.id, name);
        } catch (e) {
          return errSummary(errMessage(e));
        }
        await h.conns.loadBuckets(p, true);
        h.conns.setBucketHidden(p, name, false);
        openBucketIn(id, p, name);
        h.toast("success", `Created ${name}`);
      },
    });
  };

  const openFavorite = (f: Favorite) => {
    const p = h.profiles.find((x) => x.id === f.profileId);
    if (!p) {
      h.toast("error", "That connection no longer exists.");
      return;
    }
    h.conns.expand(p.id);
    void h.conns.loadBuckets(p);
    h.openHere((pane) => pane.go(p, f.bucket, f.prefix));
    // S3 lists a folder that is gone as an empty one: say so, and offer to drop the favorite
    if (f.prefix)
      api
        .existing(p.id, f.bucket, [], [f.prefix])
        .then((r) => {
          if (!r.prefixes.length) h.toast("error", `“${f.name}” isn’t there any more. It may have been moved or deleted.`, { label: "Remove", run: () => h.active.actions.removeFavorite(f) });
        })
        .catch(() => {});
  };

  const emptyFor = (id: PaneId): EmptyActions => ({
    onConnectKybl: () => h.setKyblDialog({ existing: null }),
    onAddConnection: () => h.setConnDialog({ profile: null }),
    onReconnect: (p) => h.setConnDialog({ profile: p, reconnect: true }),
    onNewBucket: (p) => askNewBucket(p, id),
    onOpenBucketByName: (p) => askBucketName(p, id),
    // a server's own certificate, trusted from its error: saved on the connection like any edit
    onTrustCert: async (p, fp, reopen) => {
      if (!p.net) return;
      const saved = await trustOnProfile(p, { certFingerprint: fp });
      forgetCaps(saved.id);
      h.conns.upsertProfile(saved);
      if (reopen) await h.connectIn(id, saved);
    },
    // an SFTP server's key (first seen, or changed) trusted from its error: saved the same way
    onTrustHostKey: async (p, fp, reopen) => {
      if (!p.net) return;
      const saved = await trustOnProfile(p, { hostKey: fp });
      forgetCaps(saved.id);
      h.conns.upsertProfile(saved);
      if (reopen) await h.connectIn(id, saved);
    },
    // an "encrypt if available" FTP server that offered no encryption: the user agreed to plain FTP
    onAllowPlainFtp: async (p, reopen) => {
      if (!p.net) return;
      await api.ftpAllowPlain(p.net);
      if (reopen) await h.connectIn(id, p);
    },
    // "Try again" on a connection that failed (timed out before the VPN was up): a fresh connection, then open it
    onRetryConnect: async (p) => {
      await freshConnection(p.id);
      await h.connectIn(id, p);
    },
    missing: h.rec.notes[id],
  });

  // the connection in the pane in use: first in Recent, and its kind section and group fold open
  // in the sidebar
  const activeProfile = h.active.profile;
  // (a section appears once there are a few of a kind: when the active one's section comes or
  // goes, it is revealed again; any other change in the count leaves a group the user shut alone)
  const activeScope = activeProfile ? scopeOf(h.profiles, activeProfile) : "";
  useEffect(() => {
    if (!activeProfile) return;
    h.recents.push(activeProfile.id);
    h.openGroups.reveal(revealKeys(h.profiles, activeProfile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile?.id, activeProfile?.group, activeScope]);

  /** A found or recent connection opens in the pane in use (or just takes the keyboard there, if it's already on screen). */
  const openConnection = (p: Profile) => {
    if (isShellConn(p)) return h.openShell(p);
    if (h.sideHidden) h.sidePeek.close();
    if (h.fileId == null) return h.openHere((pane) => void h.connectIn(pane.id, p));
    h.showFilePane();
    if (h.active.profile?.id !== p.id || h.active.bucket == null) void h.connectIn(h.active.id, p);
    // (two frames: the overlay holding the field that had the keyboard goes first)
    h.focusSoon(h.active.id);
  };
  /** ⌥⌘F: the filter field atop the sidebar (with it folded away, the sidebar comes in over the panes). */
  const findConnection = () => {
    if (h.sideHidden) h.sidePeek.show();
    h.setFindSignal((n) => n + 1);
  };

  /** Files connections under groups (saved at once; only the group changes). */
  const applyGroups = async (changes: GroupChanges) => {
    if (!Object.keys(changes).length) return;
    try {
      h.conns.setProfiles(await api.setProfileGroups(changes));
    } catch (e) {
      h.toast("error", `Couldn’t change the group. ${errMessage(e)}`);
    }
  };
  /** Files these connections under group `raw` ("" = the top level). */
  const moveToGroup = (ps: Profile[], raw: string) => {
    const g = normalizeGroup(raw);
    const changes = moveInto(h.saved, ps.map((p) => p.id), g);
    if (!Object.keys(changes).length) return;
    void applyGroups(changes);
    // follow them there, so they're plain where they went
    if (g) h.openGroups.reveal(revealKeys(h.profiles, { ...ps[0], group: g }));
    h.picks.clear();
  };
  /** Pins these connections, or unpins them when they all are already. */
  const togglePin = async (ids: string[]) => {
    const changes = togglePins(h.saved, ids);
    if (!Object.keys(changes).length) return;
    try {
      h.conns.setProfiles(await api.setProfilePins(changes));
      h.picks.clear();
    } catch (e) {
      h.toast("error", `Couldn’t pin. ${errMessage(e)}`);
    }
  };
  /** "Move to group" for one or several connections: every group, the top level, or a new one. */
  const groupItems = (ps: Profile[]): MenuItem[] => {
    // the group they all share, ticked
    const shared = new Set(ps.map(groupOf));
    const cur = shared.size === 1 ? [...shared][0] : null;
    const groups = allGroups(h.saved);
    const who = ps.length === 1 ? ps[0].name : `${ps.length} connections`;
    // the new group and the top level first: a long list of groups can't push them out of reach
    return tidyMenu([
      {
        type: "item",
        label: "New group…",
        icon: "folder-plus",
        onClick: () =>
          h.dialogs.prompt({
            title: "New group",
            label: `Group for ${who}`,
            initial: "",
            confirmLabel: "Move",
            note: "Use / for a group inside a group, like Clients/Acme.",
            run: (v) => moveToGroup(ps, v),
          }),
      },
      cur !== "" && { type: "item", label: "No group (top level)", icon: "arrow-up", onClick: () => moveToGroup(ps, "") },
      { type: "sep" },
      ...groups.map((g): MenuItem => ({ type: "item", label: groupLabel(g), icon: "folder", checked: g === cur || undefined, onClick: () => moveToGroup(ps, g) })),
    ]);
  };
  /**
   * Right-click on a group's row in the sidebar. A group inside a kind section ("Acme" under
   * SFTP) changes for the connections listed there: what the row shows is what moves.
   */
  const groupMenu = (path: string, scope: string, x: number, y: number) => {
    const listed = inScope(h.saved, scope);
    h.dialogs.menu(x, y, [
      {
        type: "item",
        label: "Rename group…",
        icon: "edit",
        onClick: () =>
          h.dialogs.prompt({
            title: "Rename group",
            label: "Group name",
            initial: path,
            confirmLabel: "Rename",
            note: "Use / to put it inside another group. A name that's already a group joins the two.",
            check: (v) => (normalizeGroup(v).startsWith(`${path}/`) ? "A group can’t go inside itself." : null),
            run: (v) => {
              const to = normalizeGroup(v);
              if (!to || to === path) return;
              void applyGroups(renameGroup(listed, path, to));
              h.openGroups.update((cur) => renamedOpen(cur, path, to, scope));
            },
          }),
      },
      {
        type: "item",
        // only the folder goes: its connections stay, one level up
        label: parentGroup(path) ? `Delete group (connections move into ${groupLabel(parentGroup(path))})` : "Delete group (connections stay)",
        icon: "arrow-up",
        onClick: () => {
          void applyGroups(ungroup(listed, path));
          h.openGroups.update((cur) => renamedOpen(cur, path, parentGroup(path), scope));
        },
      },
      { type: "sep" },
      { type: "item", label: "Collapse all", icon: "chevron", disabled: !h.openGroups.open.size, onClick: h.openGroups.collapseAll },
    ]);
  };
  /** Right-click on a kind section ("FTP"): fold everything shut, or add another of that kind. */
  const sectionMenu = (s: KindSection, x: number, y: number) =>
    h.dialogs.menu(x, y, [
      { type: "item", label: h.openGroups.open.has(s.key) ? "Collapse" : "Expand", icon: "chevron", onClick: () => h.openGroups.toggle(s.key) },
      { type: "item", label: "Collapse all", icon: "chevron", disabled: !h.openGroups.open.size, onClick: h.openGroups.collapseAll },
      { type: "sep" },
      { type: "item", label: `New ${s.label} connection…`, icon: "plus", onClick: () => h.setConnDialog({ profile: null, startKind: s.kind }) },
    ]);
  /**
   * The folded rail's icon for a kind section: its connections in a menu (a submenu per group
   * first, compact however long the list below them, then the connections at its top), the one on
   * screen ticked.
   */
  const railSection = (s: KindSection, x: number, y: number) => {
    const item = (p: Profile): MenuItem => ({ type: "item", label: p.name, checked: p.id === h.active.profile?.id || undefined, onClick: () => openConnection(p) });
    // menus go one submenu deep: every group holding connections is one, by its whole path
    const holding: GroupNode[] = [];
    const walk = (n: GroupNode) => {
      for (const g of n.groups) {
        if (g.items.length) holding.push(g);
        walk(g);
      }
    };
    walk(s.tree);
    const level = (n: GroupNode): MenuItem[] =>
      tidyMenu([
        ...holding.map((g): MenuItem => ({ type: "submenu", label: `${groupLabel(g.path)} (${g.items.length})`, icon: "folder", items: () => g.items.map(item) })),
        holding.length > 0 && n.items.length > 0 && { type: "sep" },
        ...n.items.map(item),
      ]);
    h.dialogs.menu(x, y, [
      { type: "label", label: `${s.label} · ${s.tree.count}` },
      ...level(s.tree),
      { type: "sep" },
      { type: "item", label: `New ${s.label} connection…`, icon: "plus", onClick: () => h.setConnDialog({ profile: null, startKind: s.kind }) },
    ]);
  };

  /** "Mount as drive…" for a bucket ("" = the whole connection) */
  const askMount = (p: Profile, b: string) =>
    h.dialogs.show((close) => (
      <MountDialog profileId={p.id} connection={p.name} bucket={b} prefix="" onClose={close} onToast={(k, t) => h.toast(k, t)} onOpenSettings={() => h.openSettings("drives")} />
    ));
  /** A bucket's (or with "", the whole connection's) drive items: Mount as drive…, or Show in Finder / Eject once it is one. */
  const driveFor = (p: Profile, b: string) =>
    driveItems(findMount(h.mounts, p.id, b, ""), { ask: () => askMount(p, b), toast: (k, t) => h.toast(k, t), openSettings: () => h.openSettings("drives") });
  /** The sidebar's drive badge: the drive's own items. */
  const driveMenu = (m: MountInfo, x: number, y: number) => {
    const p = h.profiles.find((q) => q.id === m.profileId);
    if (p) h.dialogs.menu(x, y, tidyMenu(driveFor(p, m.bucket)));
  };
  /** Right-click on a connection: everything in it (its buckets shown in the sidebar) to another connection. */
  const connectionMenu = (p: Profile, x: number, y: number) => {
    const copyAll = async () => {
      const names = h.conns.bucketsBy[p.id]?.names?.length ? h.conns.bucketsBy[p.id].names : await h.conns.loadBuckets(p);
      const hidden = new Set(h.conns.hiddenBuckets[p.id] ?? []);
      const shown = names.filter((b) => !hidden.has(b));
      if (!shown.length) return h.toast("info", "There's nothing in this connection to copy yet.");
      if (shown.length === 1) h.migrations.open({ profileId: p.id, root: shown[0], items: [{ path: "", isDir: true }] }, "copy");
      else h.migrations.open({ profileId: p.id, root: shown[0], items: [], roots: shown.map((b) => ({ id: b, name: h.conns.rootLabel(p.id, b) })) }, "copy");
    };
    const own = p.id === THIS_MAC.id;
    // a server's one root has no row of its own: the connection row is the place
    const single = rootsMode(p, peekCaps(p.id)) === "single";
    h.dialogs.menu(x, y, tidyMenu([
      ...(h.authNeeded.has(p.id) ? [{ type: "item" as const, label: "Sign in again…", icon: "refresh" as const, onClick: () => h.setConnDialog({ profile: p, reconnect: true }) }] : []),
      // an SSH connection: its terminal first, its files on request
      ...(isShellConn(p)
        ? [
            { type: "item" as const, label: "Open terminal", icon: "terminal" as const, onClick: () => h.openShell(p) },
            { type: "item" as const, label: "New terminal", icon: "plus" as const, onClick: () => h.openShell(p, true) },
            { type: "item" as const, label: "Browse files", icon: "folder" as const, onClick: () => h.openHere((pane) => pane.openBucket(p, "")) },
          ]
        : []),
      isShellConn(p)
        ? null
        : single
        ? { type: "item" as const, label: "Open", icon: "folder" as const, onClick: () => h.openHere((pane) => pane.openBucket(p, "")) }
        : { type: "item" as const, label: h.conns.expanded.has(p.id) ? "Collapse" : "Expand", icon: "chevron" as const, onClick: () => h.toggleConnection(p) },
      // all of this computer is too much to copy in one go: its folders have their own menus
      ...(own ? [] : [{ type: "item" as const, label: "Copy everything to…", icon: "copy" as const, onClick: () => void copyAll() }]),
      ...(own ? [] : driveFor(p, "")),
      ...photoMenuItems(p, h.dialogs),
      ...tunnelMenuItems(p, h.toast),
      // This Mac is built in, not saved: it stays where it is
      ...(own
        ? []
        : [
            { type: "sep" as const },
            { type: "item" as const, label: p.pinned ? "Unpin" : "Pin to the top", icon: "pin" as const, onClick: () => void togglePin([p.id]) },
            { type: "item" as const, label: "Select to organize", icon: "check" as const, onClick: () => h.picks.add(p.id) },
            { type: "submenu" as const, label: "Move to group", icon: "folder" as const, items: () => groupItems(h.picks.picked.has(p.id) ? h.saved.filter((x) => h.picks.picked.has(x.id)) : [p]) },
            { type: "item" as const, label: "Edit connection…", icon: "edit" as const, onClick: () => h.setConnDialog({ profile: p }) },
          ]),
    ]));
  };
  /**
   * A connection's roots in a menu (the rail's, the pane badge's), with the sidebar's wording and
   * extras: S3 opens a bucket by name, Kybl Storage makes a new one, drives just list.
   */
  const rootMenuItems = (p: Profile, shown: string[], here: string | null, open: (b: string) => void, id: PaneId): MenuItem[] => {
    const caps = peekCaps(p.id);
    const buckets = rootsMode(p, caps) === "buckets";
    const canCreate = caps ? caps.createRoot : p.provider === KYBL;
    const own = p.id === THIS_MAC.id;
    const icon = rootIcon(p.id);
    const extra: MenuItem[] = own
      ? []
      : canCreate
        ? [{ type: "sep" }, { type: "item", label: "New bucket…", icon: "plus", onClick: () => askNewBucket(p, id) }]
        : buckets
          ? [{ type: "sep" }, { type: "item", label: "Open bucket by name…", icon: "plus", onClick: () => askBucketName(p, id) }]
          : [];
    return [
      ...shown.map((b): MenuItem => ({ type: "item", label: h.conns.rootLabel(p.id, b), icon, checked: b === here || undefined, onClick: () => open(b) })),
      ...(!shown.length ? [{ type: "item" as const, label: h.conns.bucketsBy[p.id]?.note ?? (buckets ? "No buckets yet" : "Nothing here yet"), disabled: true, onClick: () => {} }] : []),
      ...extra,
    ];
  };
  /** The folded sidebar: a connection's icon lists its buckets (a server's one root just opens). */
  const railPick = async (p: Profile, x: number, y: number) => {
    if (isShellConn(p)) return h.openShell(p);
    if (h.fileId == null || !h.active.profile) return h.openHere((pane) => void h.connectIn(pane.id, p));
    if (rootsMode(p, peekCaps(p.id)) === "single") {
      return h.openHere((pane) => pane.openBucket(p, ""));
    }
    const names = await h.conns.loadBuckets(p);
    const hidden = new Set(h.conns.hiddenBuckets[p.id] ?? []);
    const shown = names.filter((b) => !hidden.has(b));
    const here = h.active.profile?.id === p.id ? h.active.bucket : null;
    h.dialogs.menu(x, y, [{ type: "label", label: p.name }, ...rootMenuItems(p, shown, here, (b) => h.openHere((pane) => pane.openBucket(p, b)), h.active.id)]);
  };
  /** The badge before a pane's path: every connection, each with its buckets, opened in that pane. */
  const switchMenu = (id: PaneId, x: number, y: number) => {
    const pane = h.paneById(id);
    const open = (p: Profile, b: string) => {
      h.setActiveId(id);
      pane.openBucket(p, b);
      h.focusSoon(id);
    };
    h.dialogs.menu(x, y, [
      // pinned, recent, groups, then the rest, with a search over all of them (organizeMenu.ts)
      ...connectionMenuItems(h.profiles, {
        recent: h.recents.recent,
        skipRecent: pane.profile?.id,
        row: (p, nested): MenuItem => {
          const current = pane.profile?.id === p.id;
          const single = rootsMode(p, peekCaps(p.id)) === "single";
          // inside a group (and in search results) a menu can't go another level down for the
          // buckets: the row opens the connection, and its buckets are in the pane
          if (single || nested) {
            return {
              type: "item",
              label: p.name,
              checked: current || undefined,
              onClick: () =>
                // an SSH connection opens as its terminal, here as from the sidebar
                isShellConn(p) && !current
                  ? (h.setActiveId(id), h.term.shellIn(id, p.id))
                  : single
                    ? open(p, "")
                    : (h.setActiveId(id), void h.connectIn(id, p), h.focusSoon(id)),
            };
          }
          return {
            type: "submenu",
            label: current ? `${p.name} ✓` : p.name,
            items: async () => {
              const names = h.conns.bucketsBy[p.id]?.names?.length ? h.conns.bucketsBy[p.id].names : await h.conns.loadBuckets(p).catch(() => [] as string[]);
              const hidden = new Set(h.conns.hiddenBuckets[p.id] ?? []);
              const shown = names.filter((b) => !hidden.has(b));
              return rootMenuItems(p, shown, current ? pane.bucket : null, (b) => open(p, b), id);
            },
          };
        },
      }),
      { type: "sep" },
      { type: "item", label: "New connection…", icon: "plus", onClick: () => h.setConnDialog({ profile: null }) },
    ]);
  };
  /** Right-click on a bucket (or one of this computer's folders) in the sidebar. */
  const bucketMenu = (p: Profile, b: string, x: number, y: number) => {
    const hidden = (h.conns.hiddenBuckets[p.id] ?? []).includes(b);
    h.dialogs.menu(x, y, tidyMenu([
      { type: "item", label: "Open", icon: p.id === THIS_MAC.id ? "folder" : "bucket", onClick: () => h.openHere((pane) => pane.openBucket(p, b)) },
      { type: "item", label: "Copy everything to…", icon: "copy", onClick: () => h.migrations.open({ profileId: p.id, root: b, items: [{ path: "", isDir: true }] }, "copy") },
      ...(p.id === THIS_MAC.id ? [] : driveFor(p, b)),
      { type: "sep" },
      { type: "item", label: hidden ? "Show in the sidebar" : "Hide from the sidebar", icon: hidden ? "eye" : "eye-off", onClick: () => h.conns.setBucketHidden(p, b, !hidden) },
    ]));
  };
  return { askBucketName, askNewBucket, openFavorite, emptyFor, openConnection, findConnection, moveToGroup, togglePin, groupItems, groupMenu, sectionMenu, railSection, driveMenu, connectionMenu, railPick, switchMenu, bucketMenu };
}
