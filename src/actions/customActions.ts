/**
 * Custom actions (Settings → Actions): shell command lines with placeholders, run on the selected
 * files and folders, on this computer or over SSH on an SFTP server. Kept per device in
 * localStorage. Running, quoting and the output stream are the backend's (src-tauri/src/actions.rs):
 * every placeholder value is shell-quoted there.
 *
 * Wiring: `actionsMenu` (the item context menu's "Actions ▸"), `actionCommandMap` (pane commands,
 * so shortcuts route like the built-in ones), `useActionShortcuts` (the keys) and
 * `useActionPalette` (the ⌘K palette's "Run …" commands, see `customActionCommands`).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createElement, useEffect, useRef } from "react";
import { api, errMessage } from "../api";
import { asExport } from "../connections/native";
import { joinPath, safeRelPath } from "../desktop/paths";
import { MENU_ACCELERATORS } from "../desktop/menus";
import { registerCommands, type PaletteCommand } from "../palette/commands";
import { createStore, useStore } from "../store";
import type { MenuItem } from "../components/Dialogs";
import type { Dialogs } from "../shell/useDialogs";
import type { TransferActions } from "../useTransfers";
import type { useJobs } from "../useJobs";
import type { Entry, Profile, Transfer } from "../types";
import { OutputSheet } from "./OutputSheet";
import { extList, hasExt } from "./extMatch";

// ------------------------------------------------------------ the actions

export type ActionWhere = "local" | "server";
export type ActionTargets = "files" | "folders" | "both";

export type CustomAction = {
  id: string;
  name: string;
  /** a shell command line with {path} {paths} {name} {dir} {ext} {stem} */
  command: string;
  where: ActionWhere;
  appliesTo: ActionTargets;
  /** "jpg, png": files with these extensions only; "" = any */
  extensions: string;
  /** show the output sheet, or run quietly and say when done */
  output: "show" | "silent";
  /** reload the folder once it ran */
  refresh: boolean;
  /** "Mod+Shift+KeyO" (see `comboFromEvent`), null = none */
  shortcut: string | null;
  enabled: boolean;
};

const KEY = "kybl.customActions";
/** Asked before running on more items than this. */
export const CONFIRM_OVER = 20;
/** Output kept per run in the page (the backend stops sending at the same size). */
const OUTPUT_LIMIT = 1024 * 1024;

const UA = typeof navigator === "undefined" ? "" : navigator.userAgent;
const MAC = /Mac/.test(UA);
/** "on this Mac" */
export const LOCAL_PHRASE = `on this ${MAC ? "Mac" : /Win/.test(UA) ? "PC" : "computer"}`;
/** "On this Mac" */
export const LOCAL_LABEL = LOCAL_PHRASE[0].toUpperCase() + LOCAL_PHRASE.slice(1);

const example = (id: string, name: string, command: string, where: ActionWhere, over: Partial<CustomAction> = {}): CustomAction => ({
  id,
  name,
  command,
  where,
  appliesTo: "files",
  extensions: "",
  output: "show",
  refresh: false,
  shortcut: null,
  enabled: false,
  ...over,
});

/** A few to start from, off until switched on. */
export const EXAMPLES: CustomAction[] = [
  example("ex-optimize", "Optimize images", "sips -Z 2048 {path}", "local", { extensions: "jpg, jpeg, png, heic", output: "silent" }),
  example("ex-sha256", "Compute SHA-256", "shasum -a 256 {paths}", "local"),
  example("ex-du", "Disk usage on server", "du -sh {path}", "server", { appliesTo: "both" }),
  example("ex-chmod", "Make executable", "chmod +x {paths}", "server", { output: "silent", refresh: true }),
];

const isWhere = (v: unknown): v is ActionWhere => v === "local" || v === "server";
const isTargets = (v: unknown): v is ActionTargets => v === "files" || v === "folders" || v === "both";

/** A saved action as far as it makes sense; null when it doesn't. */
function clean(raw: unknown): CustomAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || typeof r.command !== "string" || !r.name.trim() || !r.command.trim()) return null;
  return {
    id: typeof r.id === "string" && r.id ? r.id : newId(),
    name: r.name.trim(),
    command: r.command,
    where: isWhere(r.where) ? r.where : "local",
    appliesTo: isTargets(r.appliesTo) ? r.appliesTo : "files",
    extensions: typeof r.extensions === "string" ? r.extensions : "",
    output: r.output === "silent" ? "silent" : "show",
    refresh: r.refresh === true,
    shortcut: typeof r.shortcut === "string" && r.shortcut ? r.shortcut : null,
    enabled: r.enabled !== false,
  };
}

export const newId = () => `ca-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function load(): CustomAction[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return EXAMPLES;
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.map(clean).filter((a): a is CustomAction => !!a) : EXAMPLES;
  } catch {
    return EXAMPLES;
  }
}

export const actionsStore = createStore<CustomAction[]>(load());
actionsStore.subscribe(() => {
  try {
    localStorage.setItem(KEY, JSON.stringify(actionsStore.get()));
  } catch {
    /* storage off: they last until the app closes */
  }
});

export const useCustomActions = () => useStore(actionsStore);

export function saveAction(a: CustomAction) {
  actionsStore.set((list) => (list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a]));
}
export const deleteAction = (id: string) => actionsStore.set((list) => list.filter((x) => x.id !== id));

/** The actions as JSON, for Export. */
export const exportActions = () => JSON.stringify({ kyblActions: 1, actions: actionsStore.get() }, null, 2);

/**
 * The actions in an exported JSON, for the user to look over before adding them. Commands are
 * code from somewhere else: they come in switched off, without a shortcut and showing their output,
 * and each is switched on by hand.
 */
export function parseImport(json: string): CustomAction[] {
  const data = JSON.parse(json);
  const list: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.actions) ? data.actions : [];
  const got = list.map(clean).filter((a): a is CustomAction => !!a);
  if (!got.length) throw new Error("No actions in that text.");
  return got.map((a) => ({ ...a, id: newId(), enabled: false, shortcut: null, output: "show" }));
}

/** Adds actions from `parseImport`; how many came in. */
export function addImported(list: CustomAction[]): number {
  actionsStore.set((cur) => [...cur, ...list]);
  return list.length;
}

// ------------------------------------------------------------ which items an action takes

export { extList };

/** Whether the action takes this item (kind and extension, "tar.gz" included). */
export function takes(a: CustomAction, e: Entry): boolean {
  if (e.kind === "folder") return a.appliesTo !== "files";
  if (a.appliesTo === "folders") return false;
  const exts = extList(a.extensions);
  return !exts.length || hasExt(e.name, exts);
}

export type ActionContext = {
  profile: Profile | null;
  bucket: string | null;
  /** the folder on screen */
  prefix: string;
  /** the connection is this computer's disk (`localPaths`) */
  onDisk: boolean;
  dialogs: Dialogs;
  transfers: TransferActions;
  jobs: ReturnType<typeof useJobs>;
  /** reloads the folder on screen */
  refresh: () => void;
  /** the selected items, for commands run by key or from a palette */
  selection: () => Entry[];
};

/** Whether the action can run here at all, and if not why (null = it can't and says nothing). */
function placeProblem(a: CustomAction, ctx: ActionContext): string | null | undefined {
  if (!ctx.profile || ctx.bucket == null) return null;
  if (a.where === "server") return ctx.profile.kind === "sftp" ? undefined : null;
  return undefined;
}

/** The items of `list` the action runs on, or why it can't. */
export function targetsFor(a: CustomAction, ctx: ActionContext, list: Entry[]): { targets: Entry[]; why?: string } {
  let targets = list.filter((e) => takes(a, e));
  // a server's folders aren't copied over to run something on them here
  if (a.where === "local" && !ctx.onDisk && targets.some((e) => e.kind === "folder")) {
    targets = targets.filter((e) => e.kind === "file");
    if (!targets.length) return { targets, why: `Folders on a server can’t run ${LOCAL_PHRASE}` };
  }
  return { targets };
}

/** Enabled actions that apply to this place and take at least one of `list`. */
export function actionsFor(ctx: ActionContext, list: Entry[]) {
  return actionsStore
    .get()
    .filter((a) => a.enabled && placeProblem(a, ctx) === undefined)
    .map((a) => ({ action: a, ...targetsFor(a, ctx, list) }))
    .filter((x) => x.targets.length > 0 || x.why);
}

/** The context menu's "Actions ▸", or nothing when no action applies. */
export function actionsMenu(ctx: ActionContext, list: Entry[]): MenuItem[] {
  const got = actionsFor(ctx, list);
  if (!got.length) return [];
  return [
    {
      type: "submenu",
      label: "Actions",
      icon: "play",
      items: () =>
        got.map(({ action: a, targets, why }) => ({
          type: "item" as const,
          label: list.length > 1 && targets.length !== list.length && targets.length ? `${a.name} (${targets.length} of ${list.length})` : a.name,
          icon: a.where === "server" ? ("server" as const) : ("laptop" as const),
          hint: why ?? (a.shortcut ? comboLabel(a.shortcut) : undefined),
          disabled: !targets.length,
          onClick: () => void runAction(ctx, a, list),
        })),
    },
  ];
}

/** Pane commands by id, so a shortcut routes like the built-in ones ("custom-action:<id>"). */
export function actionCommandMap(ctx: ActionContext): Record<string, () => void> {
  const out: Record<string, () => void> = {};
  for (const a of actionsStore.get()) if (a.enabled) out[`custom-action:${a.id}`] = () => void runFromCommand(ctx, a);
  return out;
}

/** Why the action can't run on `list` here, or null when it can (the palette's greyed reason). */
function refusal(a: CustomAction, ctx: ActionContext, list: Entry[]): string | null {
  if (!ctx.profile || ctx.bucket == null) return "Open a folder first";
  if (placeProblem(a, ctx) !== undefined) return "Runs on SFTP servers only";
  if (!list.length) return "Select the items to run it on";
  const { targets, why } = targetsFor(a, ctx, list);
  if (targets.length) return null;
  if (why) return why;
  const exts = extList(a.extensions);
  if (a.appliesTo === "folders") return "Select folders";
  return exts.length ? `Select ${exts.map((x) => `.${x}`).join(", ")} files` : a.appliesTo === "files" ? "Select files" : "Doesn’t apply to the selection";
}

/**
 * The ⌘K palette's commands: "Run “name”" per enabled action, on the active pane's selection, greyed
 * with the reason when it can't run there.
 */
export function customActionCommands(ctx: ActionContext): PaletteCommand[] {
  const list = ctx.selection();
  return actionsStore
    .get()
    .filter((a) => a.enabled)
    .map((a) => ({
      id: `custom-action:${a.id}`,
      title: `Run “${a.name}”`,
      group: "Actions",
      keywords: `custom action command ${a.command}`,
      shortcut: a.shortcut ? comboLabel(a.shortcut) : undefined,
      icon: a.where === "server" ? ("server" as const) : ("laptop" as const),
      disabled: refusal(a, ctx, list),
      run: () => void runAction(ctx, a, list),
    }));
}

/** Registers the custom actions with the ⌘K palette, run on the active pane (`active()` at opening). */
export function useActionPalette(active: () => ActionContext | null) {
  const get = useRef(active);
  get.current = active;
  useEffect(
    () =>
      registerCommands("custom-actions", () => {
        const ctx = get.current();
        return ctx ? customActionCommands(ctx) : [];
      }),
    [],
  );
}

async function runFromCommand(ctx: ActionContext, a: CustomAction) {
  const p = placeProblem(a, ctx);
  if (p !== undefined) return void ctx.dialogs.toast("info", p ?? (a.where === "server" ? `“${a.name}” runs on SFTP servers only.` : `“${a.name}” can’t run here.`));
  const list = ctx.selection();
  if (!list.length) return void ctx.dialogs.toast("info", `Select the items to run “${a.name}” on.`);
  await runAction(ctx, a, list);
}

// ------------------------------------------------------------ shortcuts

const CODE_LABEL: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Space: "Space",
  Enter: "↵",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** The key of a combo string's last part: "KeyO" → "O", "Digit1" → "1". */
const keyLabel = (code: string) => CODE_LABEL[code] ?? code.replace(/^Key|^Digit|^Numpad/, "");

/**
 * A keydown as a combo: "Mod+Alt+Shift+KeyO" (Mod is ⌘ on a Mac, Ctrl elsewhere; by key position,
 * so ⌥ doesn't change it). Null for a bare modifier, and for keys that need a modifier but have
 * none (only F-keys work alone).
 */
export function comboFromEvent(ev: KeyboardEvent | React.KeyboardEvent): string | null {
  const code = ev.code;
  if (!code || /^(Meta|Control|Alt|Shift|OS|CapsLock|Fn)/.test(code)) return null;
  const mod = ev.metaKey || ev.ctrlKey;
  const fkey = /^F([1-9]|1[0-9])$/.test(code);
  if (!mod && !fkey) return null;
  return [mod && "Mod", ev.altKey && "Alt", ev.shiftKey && "Shift", code].filter(Boolean).join("+");
}

/** "Mod+Shift+KeyO" → "⇧⌘O" (Mac) or "Ctrl+Shift+O". */
export function comboLabel(combo: string): string {
  const parts = combo.split("+");
  const code = parts[parts.length - 1];
  const has = (p: string) => parts.includes(p);
  if (MAC) return `${has("Alt") ? "⌥" : ""}${has("Shift") ? "⇧" : ""}${has("Mod") ? "⌘" : ""}${keyLabel(code)}`;
  return [has("Mod") && "Ctrl", has("Alt") && "Alt", has("Shift") && "Shift", keyLabel(code)].filter(Boolean).join("+");
}

/** Keys the app (useShortcuts, the menu bar, the system) already has, as combos. */
const RESERVED: Record<string, string> = (() => {
  const r: Record<string, string> = {};
  const add = (label: string, ...combos: string[]) => combos.forEach((c) => (r[c] = label));
  add("Settings", "Mod+Comma");
  add("New folder", "Mod+Shift+KeyN");
  add("Upload", "Mod+KeyU", "Mod+Shift+KeyU");
  add("Download", "Mod+Shift+KeyD");
  add("Back / forward", "Mod+BracketLeft", "Mod+BracketRight");
  add("Go to folder", "Mod+Shift+KeyG", "Mod+KeyL");
  add("Get Info", "Mod+KeyI");
  add("Refresh", "Mod+KeyR");
  add("Search", "Mod+KeyF", "Mod+Alt+KeyF");
  add("Split panes", "Mod+Backslash", "Mod+Shift+Backslash");
  add("Close pane", "Mod+KeyW");
  add("Move between panes", "Mod+Alt+ArrowUp", "Mod+Alt+ArrowDown", "Mod+Alt+ArrowLeft", "Mod+Alt+ArrowRight");
  add("Swap panes", "Mod+Shift+KeyS");
  add("Show or hide the sidebar", "Mod+Alt+KeyS");
  add("Tile size", "Mod+Equal", "Mod+Minus", "Mod+Shift+Equal");
  add("Select all", "Mod+KeyA");
  add("Copy / cut / paste", "Mod+KeyC", "Mod+KeyX", "Mod+KeyV");
  add("Undo", "Mod+KeyZ", "Mod+Shift+KeyZ");
  add("Duplicate", "Mod+KeyD");
  add("Open", "Mod+KeyO", "Mod+ArrowDown");
  add("Up one level", "Mod+ArrowUp");
  add("Delete", "Mod+Backspace");
  add("Show hidden files", "Mod+Shift+Period");
  add("New workspace", "Mod+KeyT");
  add("Next / previous workspace", "Mod+Shift+BracketLeft", "Mod+Shift+BracketRight");
  add("Move the workspace", "Mod+Alt+Shift+BracketLeft", "Mod+Alt+Shift+BracketRight");
  for (let i = 1; i <= 9; i++) add("Go to workspace", `Mod+Alt+Digit${i}`);
  add("Rename", "F2");
  add("Two panes: quick look, copy, move, new folder, delete", "F3", "F5", "F6", "F7", "F8");
  add("Actions menu", "Shift+F10");
  // the system's and the window's, and the command palette
  add("Quit, hide, minimize", "Mod+KeyQ", "Mod+KeyH", "Mod+KeyM", "Mod+Alt+KeyH");
  add("New window / connection", "Mod+KeyN");
  add("Command palette", "Mod+KeyK", "Mod+KeyP", "Mod+Shift+KeyP");
  add("Save, print", "Mod+KeyS", "Mod+KeyP");
  add("Terminal", "Mod+Backquote");
  return r;
})();

/** Why `combo` can't be this action's shortcut (taken by the app or another action), or null. */
export function shortcutProblem(combo: string, selfId: string | null, list = actionsStore.get()): string | null {
  const parts = combo.split("+");
  if (!parts.includes("Mod") && !/^F\d+$/.test(parts[parts.length - 1])) return MAC ? "Use ⌘ with a key, or an F-key." : "Use Ctrl with a key, or an F-key.";
  const taken = RESERVED[combo];
  if (taken) return `${comboLabel(combo)} is already ${taken}.`;
  // the menu bar's accelerators (menus.ts) in their own words: "⇧⌘N"
  const label = comboLabel(combo);
  const menu = Object.entries(MENU_ACCELERATORS).find(([, k]) => k.replace("−", "-") === label);
  if (menu) return `${label} is already in the menu bar (${menu[0]}).`;
  const other = list.find((a) => a.id !== selfId && a.shortcut === combo);
  if (other) return `${label} is already “${other.name}”.`;
  return null;
}

/**
 * Runs the action whose shortcut was pressed, through `route` (so nothing runs behind a dialog or
 * in Settings, and on the active pane).
 */
export function useActionShortcuts(route: (id: string) => boolean) {
  const r = useRef(route);
  r.current = route;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented || ev.isComposing) return;
      const t = ev.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return;
      const combo = comboFromEvent(ev);
      if (!combo) return;
      const a = actionsStore.get().find((x) => x.enabled && x.shortcut === combo);
      if (a && r.current(`custom-action:${a.id}`)) ev.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

// ------------------------------------------------------------ runs and their output

export type RunState = "preparing" | "running" | "done" | "failed" | "stopped";
export type Segment = { s: "out" | "err" | "note"; t: string };

export type Run = {
  id: string;
  name: string;
  /** "on this Mac", "on files.example.com" */
  where: string;
  items: number;
  state: RunState;
  /** what it's doing before it runs ("Getting 3 files…") */
  status: string | null;
  segments: Segment[];
  size: number;
  truncated: boolean;
  code: number | null;
  commands: number;
  error: string | null;
  started: number;
  finished: number | null;
};

export const runsStore = createStore<Record<string, Run>>({});
const KEEP_RUNS = 12;

const patchRun = (id: string, p: Partial<Run> | ((r: Run) => Partial<Run>)) =>
  runsStore.set((all) => {
    const r = all[id];
    if (!r) return all;
    return { ...all, [id]: { ...r, ...(typeof p === "function" ? p(r) : p) } };
  });

/** Output waiting to go into the store (at most every 60 ms, so a chatty command doesn't re-render per line). */
const pending = new Map<string, Segment[]>();
let flushTimer: number | null = null;

function append(run: Run, add: Segment[]): Partial<Run> {
  const segments = run.segments.slice();
  let size = run.size;
  let truncated = run.truncated;
  for (const seg of add) {
    if (size >= OUTPUT_LIMIT && seg.s !== "note") {
      truncated = true;
      continue;
    }
    const t = seg.s === "note" ? seg.t : seg.t.slice(0, OUTPUT_LIMIT - size);
    size += t.length;
    const last = segments[segments.length - 1];
    if (last && last.s === seg.s) segments[segments.length - 1] = { s: seg.s, t: last.t + t };
    else segments.push({ s: seg.s, t });
  }
  return { segments, size, truncated };
}

function flushOutput() {
  flushTimer = null;
  for (const [id, segs] of pending) patchRun(id, (r) => append(r, segs));
  pending.clear();
}

let listening = false;
function listenOnce() {
  if (listening) return;
  listening = true;
  listen<{ runId: string; stream: Segment["s"]; text: string }>("custom-action-output", (e) => {
    const { runId, stream, text } = e.payload;
    if (!runsStore.get()[runId]) return;
    const list = pending.get(runId) ?? [];
    list.push({ s: stream, t: text });
    pending.set(runId, list);
    flushTimer ??= window.setTimeout(flushOutput, 60);
  }).catch(() => {
    listening = false;
  });
}

export const stopRun = (id: string) => invoke("custom_action_stop", { runId: id }).catch(() => {});

/** Opens the output sheet of a run. */
export function showOutput(dialogs: Dialogs, runId: string) {
  dialogs.show((close) => createElement(OutputSheet, { runId, onClose: close, onStop: () => stopOrCancel(runId) }));
}

type RunEnd = { code: number | null; stopped: boolean; truncated: boolean; commands: number };

const whatOf = (n: number) => (n === 1 ? "1 item" : `${n.toLocaleString()} items`);

/** Absolute paths on this computer of the items (and the folder), downloading server files first. */
async function localItems(ctx: ActionContext, runId: string, targets: Entry[]): Promise<{ items: { path: string; isDir: boolean }[]; dir: string } | null> {
  const { profile, bucket, prefix } = ctx;
  if (!profile || bucket == null) return null;
  const pid = profile.id;
  if (ctx.onDisk) {
    const items = await Promise.all(
      targets.map(async (e) => {
        const path = await api.localPath(pid, bucket, e.key.replace(/\/+$/, ""));
        if (!path) throw new Error(`“${e.name}” isn’t on this computer.`);
        return { path, isDir: e.kind === "folder" };
      }),
    );
    return { items, dir: (await api.localPath(pid, bucket, prefix.replace(/\/+$/, ""))) ?? "" };
  }
  // a temporary copy of each file, side by side in one folder of this run ({dir})
  const dir = joinPath(await api.tempFolder(), `actions/${runId}`);
  const used = new Set<string>();
  const files = targets.flatMap((e) => {
    const x = asExport(e);
    if (!x) return [];
    let rel = safeRelPath(x.name) || "file";
    for (let n = 2; used.has(rel.toLowerCase()); n++) rel = `${n}/${safeRelPath(x.name) || "file"}`;
    used.add(rel.toLowerCase());
    return [{ e, x, local: joinPath(dir, rel) }];
  });
  if (!files.length) throw new Error("These files can’t be downloaded.");
  patchRun(runId, { status: files.length === 1 ? `Getting “${files[0].x.name}”…` : `Getting ${files.length} files…` });
  const started = ctx.transfers.add(
    files.map(({ e, x, local }) => ({ kind: "download" as const, name: x.name, profileId: pid, bucket, key: x.key, local, total: x.size, overwrite: true, etag: e.native ? undefined : x.etag })),
  );
  // Stop while getting them cancels these downloads too (see stopOrCancel)
  preparing.set(runId, () => started.forEach((t) => ctx.transfers.cancel(t.id)));
  let done: Transfer[];
  try {
    done = await Promise.all(started.map((t) => ctx.transfers.whenFinished(t.id)));
  } finally {
    preparing.delete(runId);
  }
  const bad = done.find((t) => t.state !== "done");
  if (bad) throw new Error(bad.state === "cancelled" ? "Cancelled" : `Couldn’t get “${bad.name}”. ${bad.error ?? ""}`.trim());
  return { items: done.map((t) => ({ path: t.local, isDir: false })), dir };
}

/** Runs an action on the items of `list` it takes, after asking when they are many. */
export async function runAction(ctx: ActionContext, a: CustomAction, list: Entry[]): Promise<void> {
  const { profile, bucket, dialogs } = ctx;
  if (!profile || bucket == null) return;
  const { targets, why } = targetsFor(a, ctx, list);
  if (!targets.length) return void dialogs.toast("info", why ?? `“${a.name}” doesn’t apply to ${list.length === 1 ? "this item" : "these items"}.`);
  if (targets.length > CONFIRM_OVER) {
    const ok = await dialogs.confirm({
      title: `Run “${a.name}” on ${whatOf(targets.length)}?`,
      label: "Run",
      message: createElement("p", null, createElement("code", null, a.command)),
    });
    if (!ok) return;
  }
  listenOnce();
  const server = a.where === "server";
  const where = server ? `on ${profile.net?.host || profile.name}` : LOCAL_PHRASE;
  // the job's id is the run's: Activity's Stop reaches the backend's flag under it
  const runId = ctx.jobs.start({ kind: "action", title: `${a.name} ${where}`, stoppable: true });
  const run: Run = {
    id: runId,
    name: a.name,
    where,
    items: targets.length,
    state: "preparing",
    status: null,
    segments: [],
    size: 0,
    truncated: false,
    code: null,
    commands: 0,
    error: null,
    started: Date.now(),
    finished: null,
  };
  runsStore.set((all) => {
    const keep = Object.values(all)
      .sort((x, y) => y.started - x.started)
      .slice(0, KEEP_RUNS - 1);
    return { ...Object.fromEntries(keep.map((r) => [r.id, r])), [runId]: run };
  });
  if (a.output === "show") showOutput(dialogs, runId);

  const again = () => void runAction(ctx, a, list);
  const showAction = { label: "Show output", run: () => showOutput(dialogs, runId) };
  try {
    const spec = server
      ? { items: targets.map((e) => ({ path: e.key, isDir: e.kind === "folder" })), dir: ctx.prefix }
      : await localItems(ctx, runId, targets);
    if (!spec) return;
    if (runsStore.get()[runId]?.state === "stopped") throw new Error("Cancelled");
    patchRun(runId, { state: "running", status: null });
    const end = await invoke<RunEnd>("custom_action_run", {
      spec: { runId, template: a.command, onServer: server, profileId: profile.id, items: spec.items, dir: spec.dir },
    });
    flushOutput();
    const state: RunState = end.stopped ? "stopped" : end.code === 0 ? "done" : "failed";
    patchRun(runId, { state, code: end.code, commands: end.commands, ...(end.truncated ? { truncated: true } : {}), finished: Date.now() });
    const failed = state === "failed" ? `Exit code ${end.code ?? "unknown"}` : null;
    ctx.jobs.finish(runId, { error: state === "stopped" ? "Cancelled" : failed }, failed ? again : undefined);
    // quick ones that went fine leave no trace in Activity
    if (state === "done" && Date.now() - run.started < 3000) ctx.jobs.dismiss(runId);
    if (a.refresh && state !== "stopped") ctx.refresh();
    if (a.output === "silent" && state !== "stopped") {
      if (state === "done") dialogs.toast("success", `“${a.name}” finished`, showAction);
      else dialogs.toast("error", `“${a.name}” failed (exit code ${end.code ?? "unknown"})`, showAction);
    }
  } catch (err) {
    flushOutput();
    const msg = err instanceof Error ? err.message : errMessage(err);
    const stopped = msg === "Cancelled";
    patchRun(runId, { state: stopped ? "stopped" : "failed", status: null, error: stopped ? null : msg, finished: Date.now() });
    ctx.jobs.finish(runId, { error: stopped ? "Cancelled" : msg }, stopped ? undefined : again);
    if (!stopped && a.output === "silent") dialogs.toast("error", `“${a.name}” couldn’t run. ${msg}`);
  }
}

/** Cancels the downloads of a run that is still getting its files, by run id. */
const preparing = new Map<string, () => void>();

/** Stop: before it runs (still downloading) marks it so it never starts and cancels the downloads; while running asks the backend. */
export function stopOrCancel(runId: string) {
  const r = runsStore.get()[runId];
  if (r?.state === "preparing") {
    patchRun(runId, { state: "stopped", finished: Date.now() });
    preparing.get(runId)?.();
  }
  void stopRun(runId);
}

/** What the template turns into for some sample items (the editor's preview). */
export const previewCommand = (template: string, items: { path: string; isDir: boolean }[], dir: string) =>
  invoke<string[]>("custom_action_preview", { template, items, dir });
