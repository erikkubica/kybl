/**
 * The bell's list: every toast the app showed, kept so one that came while you were busy (a
 * background copy that failed, say) is still there to read later instead of popping up over
 * whatever you were doing. In memory for this session; newest first, capped. `useDialogs`
 * decides which toasts also pop up on screen; the bell (NotificationBell) lists all of them.
 */
import { useSyncExternalStore } from "react";
import type { ToastAction } from "../desktop/fileOps";

export type Notification = {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
  action?: ToastAction;
  at: number;
  read: boolean;
};

const MAX = 100;
let entries: Notification[] = [];
let seq = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** Adds an entry at the top; `read` when the user was already told (it popped up as an answer). */
export function addNotification(kind: Notification["kind"], text: string, action: ToastAction | undefined, read: boolean) {
  entries = [{ id: ++seq, kind, text, action, at: Date.now(), read }, ...entries].slice(0, MAX);
  emit();
}

export function markAllRead() {
  if (entries.every((n) => n.read)) return;
  entries = entries.map((n) => (n.read ? n : { ...n, read: true }));
  emit();
}

export function clearNotifications() {
  if (!entries.length) return;
  entries = [];
  emit();
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};

export function useNotifications(): Notification[] {
  return useSyncExternalStore(subscribe, () => entries);
}

// ---------------------------------------------------------------- was it an answer to the user?
// A toast that follows a click or a key press is the app answering it, so it may pop up. One with
// no input just before it came from background work and goes to the bell. The time of the last
// input is tracked once, with capture listeners, so no caller has to say anything.
let lastInput = 0;
if (typeof window !== "undefined") {
  const stamp = () => void (lastInput = Date.now());
  window.addEventListener("pointerdown", stamp, true);
  window.addEventListener("keydown", stamp, true);
}

/** how soon after the last input a toast still counts as its answer */
const ANSWER_MS = 1500;

export const answersUser = () => bgDepth === 0 && Date.now() - lastInput < ANSWER_MS;

/** Inside `inBackground` or `mayBeBackground`: an error made now needn't pop up by itself. */
export const inBackgroundNow = () => bgDepth > 0 || maybeDepth > 0;

/**
 * Toasts made inside `fn` may or may not answer the user (a transfer that failed to start: right
 * after the drop, or later from the queue): they pop up only when input came just before, errors
 * included, and wait in the bell otherwise.
 */
let maybeDepth = 0;
export function mayBeBackground(fn: () => void) {
  maybeDepth++;
  try {
    fn();
  } finally {
    maybeDepth--;
  }
}

/**
 * An Undo is offered only while its toast would have been up: later, what it puts back may have
 * changed since (a workspace edited after a reset). Show, Retry and the like stay.
 */
export const UNDO_MS = 10_000;
export const actionLive = (n: Notification, now = Date.now()) => !!n.action && (n.action.label !== "Undo" || now - n.at < UNDO_MS);

/**
 * Toasts made inside `fn` report background work (a job, uploads or an archive finishing): they go
 * to the bell however recently the user clicked or typed, which only says they were busy with
 * something else.
 */
let bgDepth = 0;
export function inBackground(fn: () => void) {
  bgDepth++;
  try {
    fn();
  } finally {
    bgDepth--;
  }
}

/** A drag (a pane, files, a connection, a resize) is going on: nothing should pop up over it. */
export const dragging = () =>
  typeof document !== "undefined" &&
  !!document.body.className.match(/\b(pane-dragging|dragging-items|dragging-conn|resizing-col|resizing-row)\b/);
