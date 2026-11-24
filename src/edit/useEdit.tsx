/**
 * "Edit" for files of any connection: the menu items (Edit, Edit with ▸, Edit in Kybl), ⌘E, and
 * the flow behind them. Files of this computer open directly (nothing to upload). Anything else
 * asks the save rule first (SaveRulePrompt), then either opens in Kybl's own editor (the shell's
 * document sheet, saving under that rule) or goes to edit.rs: a private copy, opened in an app,
 * uploaded back on every save.
 */
import { createElement, useCallback, useEffect, useRef } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errMessage, errSummary, type AppChoice } from "../api";
import { appsFor } from "../desktop/appsFor";
import { okToRun, openFromConnection } from "../desktop/openGuard";
import { EDIT_MAX } from "../viewers/registry";
import { editableInKybl } from "./editable";
import { formatBytes } from "../format";
import type { MenuItem } from "../components/Dialogs";
import type { Dialogs } from "../shell/useDialogs";
import type { FileOps } from "../desktop/fileOps";
import type { TransferActions } from "../useTransfers";
import type { Entry } from "../types";
import { editApi, findSession, onUploaded, startEditing, type EditSession, type SaveRule } from "./editStore";

import { OS } from "../osNames";

/** Where a file to edit is: its connection and root, and how its pane opens files. */
export type EditPlace = {
  profileId: string;
  bucket: string;
  /** this computer's own disk: files open where they are, nothing to upload */
  onDisk: boolean;
  ops: Pick<FileOps, "openInApp" | "openWith">;
  /** the pane it's shown in (Kybl's editor goes back to its list when closed) */
  pane?: string;
};

/** The app to edit in: undefined = the default app, null = Windows' "Choose an app" window. */
type App = { path: string | null; name: string } | undefined;


export function useEdit({
  dialogs,
  transfers,
  openInKybl,
  reloadIfShowing,
}: {
  dialogs: Dialogs;
  transfers: TransferActions;
  /** shows Kybl's editor on this file; `rule` undefined for this computer's files */
  openInKybl: (place: EditPlace, e: Entry, rule: SaveRule | undefined) => void;
  reloadIfShowing: (profileId: string, bucket: string) => boolean;
}) {
  const { toast } = dialogs;
  const reload = useRef(reloadIfShowing);
  reload.current = reloadIfShowing;
  /** which app each session was opened in, for "Open it again" */
  const appOf = useRef(new Map<string, App>());

  useEffect(() => {
    void startEditing(transfers);
    // size and date changed: the folders showing it list again
    return onUploaded((s) => void reload.current(s.profileId, s.root));
  }, [transfers]);

  const askRule = useCallback(
    async (name: string, where?: string) => {
      // its own small chunk, loaded on the first edit
      const { SaveRulePrompt } = await import("./SaveRulePrompt");
      return new Promise<SaveRule | null>((resolve) => {
        dialogs.show((close) =>
          createElement(SaveRulePrompt, {
            name,
            where,
            onAnswer: (r: SaveRule | null) => {
              close();
              resolve(r);
            },
          }),
        );
      });
    },
    [dialogs],
  );

  /**
   * The private copy in its app; `asked`: about running it, already. The copy's own name is
   * checked too (edit.rs shortens long names).
   */
  const openCopy = async (s: EditSession, app: App, asked = false) => {
    await openFromConnection(s.local, dialogs.confirm, app?.path, s.name, asked);
  };

  /** A remote file in another app: the rule, a private copy, the app, then uploads on save. */
  const editIn = async (place: EditPlace, e: Entry, app: App) => {
    if (place.onDisk) {
      // already on this computer: it opens where it is, and its app saves it in place
      return app === undefined ? void place.ops.openInApp(e) : void place.ops.openWith(e, app.path);
    }
    // a program or script opened in its default app (or a terminal) runs: asked first, as on
    // Open; a script going to an editor the person picked is only read, so it isn't
    if (!(await okToRun([e.name], dialogs.confirm, app?.path))) return;
    const rule = await askRule(e.name, app?.name);
    if (!rule) return;
    const had = findSession(place.profileId, place.bucket, e.key);
    const dl = crypto.randomUUID();
    const row = { id: dl, kind: "download" as const, name: e.name, profileId: place.profileId, bucket: place.bucket, key: e.key, local: "", total: e.size };
    if (!had) transfers.track({ ...row, state: "running", bytes: 0 });
    try {
      const s = await editApi.start(place.profileId, place.bucket, e.key, rule);
      if (!had) transfers.track({ ...row, local: s.local, state: "done", bytes: e.size });
      appOf.current.set(s.id, app);
      await openCopy(s, app, true);
      if (!had) toast("info", `Editing “${e.name}”. ${rule === "auto" ? "Each save uploads it." : "Each save uploads it if the server's copy hasn't changed."}`);
    } catch (err) {
      const msg = errMessage(err);
      if (!had) transfers.track({ ...row, state: "error", bytes: 0, error: msg });
      toast("error", `Couldn't edit “${e.name}”. ${errSummary(msg)}`);
    }
  };

  /** Kybl's own editor, under the rule picked for this edit. */
  const editHere = async (place: EditPlace, e: Entry) => {
    if (e.size > EDIT_MAX) return toast("info", `Files up to ${formatBytes(EDIT_MAX)} can be edited in Kybl. Edit opens this one in another app.`);
    if (place.onDisk) return openInKybl(place, e, undefined);
    const rule = await askRule(e.name, "Kybl");
    if (rule) openInKybl(place, e, rule);
  };

  /** "Other…" on macOS: any app, picked in a file dialog. */
  const pickApp = async (place: EditPlace, e: Entry) => {
    const path = await openDialog({ title: "Choose an app", defaultPath: "/Applications", filters: [{ name: "Applications", extensions: ["app"] }] }).catch(() => null);
    if (typeof path === "string") await editIn(place, e, { path, name: path.split("/").pop()?.replace(/\.app$/, "") ?? "the app" });
  };

  const appItems = (place: EditPlace, e: Entry, apps: AppChoice[]): MenuItem[] => {
    const toItem = (a: AppChoice): MenuItem => ({
      type: "item",
      label: a.name,
      image: a.icon ?? undefined,
      icon: a.icon ? undefined : "external",
      hint: a.isDefault ? "default" : undefined,
      onClick: () => void editIn(place, e, { path: a.path, name: a.name }),
    });
    const def = apps.filter((a) => a.isDefault);
    const rest = apps.filter((a) => !a.isDefault);
    const other: MenuItem | null =
      OS === "mac"
        ? { type: "item", label: "Other…", icon: "more", onClick: () => void pickApp(place, e) }
        : OS === "win"
          ? { type: "item", label: "Choose another app…", icon: "more", onClick: () => void editIn(place, e, { path: null, name: "" }) }
          : null;
    const out: (MenuItem | false | null)[] = [...def.map(toItem), def.length > 0 && rest.length > 0 && { type: "sep" }, ...rest.map(toItem), !!other && apps.length > 0 && { type: "sep" }, other];
    return out.filter((x): x is MenuItem => !!x);
  };

  /** The context menu's edit items for one file; none for folders and Google Docs. */
  const itemsFor = (place: EditPlace, e: Entry): MenuItem[] => {
    if (e.kind !== "file" || e.native) return [];
    const inKybl = editableInKybl(e);
    const here: MenuItem | false = inKybl && {
      type: "item",
      label: "Edit in Kybl",
      icon: "text",
      disabled: e.size > EDIT_MAX,
      hint: e.size > EDIT_MAX ? `over ${formatBytes(EDIT_MAX)}` : undefined,
      onClick: () => void editHere(place, e),
    };
    // this computer's files: Open and Open with ▸ already edit them in place
    if (place.onDisk) return here ? [here] : [];
    // warm the app list, so the submenu opens at once
    const first = appsFor(e.name, false);
    if (!Array.isArray(first)) first.catch(() => {});
    const items: (MenuItem | false)[] = [
      { type: "item", label: "Edit", icon: "edit", hint: "⌘E", onClick: () => void editIn(place, e, undefined) },
      {
        type: "submenu",
        label: "Edit with",
        icon: "edit",
        items: () => {
          const got = appsFor(e.name, false);
          return Array.isArray(got) ? appItems(place, e, got) : got.then((a) => appItems(place, e, a), () => appItems(place, e, []));
        },
      },
      here,
    ];
    return items.filter((x): x is MenuItem => !!x);
  };

  /** ⌘E and Quick Look's Edit: the default app (this computer's files: just open). */
  const editFile = (place: EditPlace, e: Entry) => {
    if (e.kind !== "file") return;
    if (e.native) return toast("info", "Google Docs, Sheets and Slides are edited in Google Drive.");
    void editIn(place, e, undefined);
  };

  /** Stops editing, asking first when a copy has changes the server doesn't have. */
  const stop = async (list: EditSession[]) => {
    const unsent = list.filter((s) => s.pending);
    if (unsent.length) {
      const ok = await dialogs.confirm({
        title: unsent.length === 1 ? `Stop editing “${unsent[0].name}”?` : `Stop editing ${list.length} files?`,
        label: "Stop editing",
        danger: true,
        message: createElement(
          "p",
          null,
          unsent.length === 1 ? "Your last changes to it weren't uploaded. Stopping deletes the copy on this computer, and those changes with it." : `${unsent.length} of them have changes that weren't uploaded. Stopping deletes the copies on this computer, and those changes with them.`,
        ),
      });
      if (!ok) return;
    }
    for (const s of list) {
      appOf.current.delete(s.id);
      await editApi.stop(s.id).catch((err) => toast("error", errMessage(err)));
    }
  };

  const reopen = (s: EditSession) => void openCopy(s, appOf.current.get(s.id)).catch((err) => toast("error", errMessage(err)));
  const reveal = (s: EditSession) => void api.revealLocal(s.local).catch((err) => toast("error", errMessage(err)));

  return { itemsFor, editFile, stop, reopen, reveal };
}

export type EditActions = ReturnType<typeof useEdit>;
