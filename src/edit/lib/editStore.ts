/**
 * Files being edited in another app (src-tauri/src/files/edit.rs): the live list, the commands, and
 * their uploads shown in the Activity panel like any transfer.
 *
 * The backend owns each session (download, watcher, upload rules); this keeps a mirror of them
 * from the `edit` event, so the page can be reloaded (or the hidden window rebuilt) without
 * losing track. Nothing here runs while nothing is being edited.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DocMeta } from "../../core/api";
import { createStore, useStore } from "../../core/store";
import type { TransferActions } from "../../transfers/hooks/useTransfers";

/** "When you save this file:" */
export type SaveRule = "auto" | "ifUnchanged";

export type EditPhase = "watching" | "uploading" | "uploaded" | "conflict" | "error";

export type EditSession = {
  id: string;
  profileId: string;
  root: string;
  /** where saves go (after "Keep both", the "(edited)" copy) */
  key: string;
  name: string;
  /** the copy on this computer */
  local: string;
  rule: SaveRule;
  phase: EditPhase;
  error: string | null;
  /** in a conflict: what the server has now; null there = it was deleted */
  server: DocMeta | null;
  lastUpload: number | null;
  uploadId: string | null;
  uploadSize: number;
  /** the copy here has changes the server doesn't have yet */
  pending: boolean;
};

export type ConflictAnswer = "overwrite" | "keepBoth" | "reload";

export const editApi = {
  start: (profileId: string, root: string, path: string, rule: SaveRule) => invoke<EditSession>("edit_start", { profileId, root, path, rule }),
  list: () => invoke<EditSession[]>("edit_list"),
  stop: (id: string) => invoke<void>("edit_stop", { id }),
  retry: (id: string) => invoke<void>("edit_retry", { id }),
  resolve: (id: string, action: ConflictAnswer) => invoke<EditSession>("edit_resolve", { id, action }),
  /** the copy here, as text (for "Compare…") */
  localText: (id: string) => invoke<string>("edit_local_text", { id }),
};

// ------------------------------------------------------------ the remembered choice

const RULE_KEY = "kybl.editSaveRule";

/** The last answer to "When you save this file:" on this device ("only if unchanged" at first). */
export function lastRule(): SaveRule {
  try {
    return localStorage.getItem(RULE_KEY) === "auto" ? "auto" : "ifUnchanged";
  } catch {
    return "ifUnchanged";
  }
}
export function rememberRule(r: SaveRule) {
  try {
    localStorage.setItem(RULE_KEY, r);
  } catch {
    /* storage off: it asks with the default next time */
  }
}

// ------------------------------------------------------------ the live list

const sessions = createStore<EditSession[]>([]);
/** Sessions whose conflict question is up (or waiting to come up), oldest first. */
const asking = createStore<string[]>([]);
/** Conflicts the person put off ("Decide later"): not asked again until another upload is tried. */
const putOff = new Set<string>();

let transfers: TransferActions | null = null;
let listening: Promise<void> | null = null;

function upsert(s: EditSession) {
  sessions.set((list) => {
    const i = list.findIndex((x) => x.id === s.id);
    if (i < 0) return [...list, s];
    const next = list.slice();
    next[i] = s;
    return next;
  });
}

function drop(id: string) {
  sessions.set((list) => list.filter((x) => x.id !== id));
  asking.set((q) => q.filter((x) => x !== id));
  putOff.delete(id);
}

/** Each upload attempt as a row in the Activity panel (In progress, then Done or Failed). */
function showAsTransfer(prev: EditSession | undefined, s: EditSession) {
  if (!transfers) return;
  // reloaded from the server: the conflict's failed row has done its job
  if (prev?.uploadId && prev.phase === "conflict" && s.phase === "watching") transfers.untrack(prev.uploadId);
  if (!s.uploadId) return;
  const base = { id: s.uploadId, kind: "upload" as const, name: s.name, profileId: s.profileId, bucket: s.root, key: s.key, local: s.local, total: s.uploadSize };
  const sameUpload = prev?.uploadId === s.uploadId;
  // a conflict answered (or a failure fixed by the next upload): its failed row has done its job
  if (prev?.uploadId && !sameUpload && (prev.phase === "conflict" || prev.phase === "error")) transfers.untrack(prev.uploadId);
  if (s.phase === "uploading") {
    if (!sameUpload || prev?.phase !== "uploading") transfers.track({ ...base, state: "running", bytes: 0 }, { retry: () => void editApi.retry(s.id).catch(() => {}) });
  } else if (sameUpload && prev?.phase === "uploading") {
    if (s.phase === "uploaded") transfers.track({ ...base, state: "done", bytes: s.uploadSize });
    else if (s.phase === "conflict") transfers.track({ ...base, state: "error", bytes: 0, error: s.server ? "Changed on the server since you opened it. Not uploaded." : "Deleted on the server since you opened it. Not uploaded." }, { retry: () => askAgain(s.id) });
    else if (s.phase === "error") transfers.track({ ...base, state: "error", bytes: 0, error: s.error }, { retry: () => void editApi.retry(s.id).catch(() => {}) });
  }
}

/** Told after each upload that went through. */
const uploadedListeners = new Set<(s: EditSession) => void>();
export function onUploaded(cb: (s: EditSession) => void): () => void {
  uploadedListeners.add(cb);
  return () => uploadedListeners.delete(cb);
}

function apply(s: EditSession | null, id: string) {
  const prev = sessions.get().find((x) => x.id === id);
  if (!s) {
    // stopped: a failed upload of it can't be retried any more
    if (prev?.uploadId && (prev.phase === "conflict" || prev.phase === "error")) transfers?.untrack(prev.uploadId);
    return drop(id);
  }
  showAsTransfer(prev, s);
  upsert(s);
  if (s.phase === "uploaded" && prev?.phase === "uploading") for (const l of uploadedListeners) l(s);
  // a (new) conflict asks; one put off waits until the person asks for it again
  if (s.phase === "conflict" && prev?.phase !== "conflict") putOff.delete(id);
  if (s.phase === "conflict" && !putOff.has(id)) asking.set((q) => (q.includes(id) ? q : [...q, id]));
  if (s.phase !== "conflict") asking.set((q) => (q.includes(id) ? q.filter((x) => x !== id) : q));
}

/** Starts mirroring the backend's sessions (once). `t` shows the uploads in the Activity panel. */
export function startEditing(t: TransferActions): Promise<void> {
  transfers = t;
  listening ??= (async () => {
    await listen<{ id: string; session: EditSession | null }>("edit", (e) => apply(e.payload.session, e.payload.id));
    try {
      for (const s of await editApi.list()) apply(s, s.id);
    } catch {
      /* phones and older backends: no editing */
    }
  })().catch(() => {
    listening = null;
  });
  return listening ?? Promise.resolve();
}

export function useEditSessions(): EditSession[] {
  return useStore(sessions);
}

/** How many files are being edited (re-renders only when that changes). */
export function useEditCount(): number {
  return useStore(sessions, (l) => l.length);
}

/** The session whose conflict question is up now, if any. */
export function useAsking(): EditSession | null {
  const q = useStore(asking);
  const list = useStore(sessions);
  return q.length ? (list.find((s) => s.id === q[0]) ?? null) : null;
}

/** "Decide later": the question goes away; the Editing list (and the failed upload) can bring it back. */
export function putOffConflict(id: string) {
  putOff.add(id);
  asking.set((q) => q.filter((x) => x !== id));
}

/** Shows a session's conflict question again. */
export function askAgain(id: string) {
  const s = sessions.get().find((x) => x.id === id);
  if (s?.phase !== "conflict") {
    void editApi.retry(id).catch(() => {});
    return;
  }
  putOff.delete(id);
  asking.set((q) => (q.includes(id) ? q : [id, ...q]));
}

export function findSession(profileId: string, root: string, key: string): EditSession | undefined {
  return sessions.get().find((s) => s.profileId === profileId && s.root === root && s.key === key);
}
