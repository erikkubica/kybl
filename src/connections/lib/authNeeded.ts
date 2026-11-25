/**
 * Sign-in connections (Google Drive, OneDrive, Dropbox) whose access ended: the backend says so
 * with a `connection-auth { profileId }` event when a refresh is refused. The sidebar and the
 * phone's home mark them "Sign in again" until a new sign-in replaces the connection.
 */
import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { CONNECTION_AUTH_EVENT } from "../../core/api";

let needed = new Set<string>();
const listeners = new Set<() => void>();
const set = (next: Set<string>) => {
  needed = next;
  listeners.forEach((l) => l());
};

let started = false;
function start() {
  if (started) return;
  started = true;
  listen<{ profileId: string }>(CONNECTION_AUTH_EVENT, (e) => {
    const id = e.payload?.profileId;
    if (id && !needed.has(id)) set(new Set(needed).add(id));
  }).catch(() => {
    started = false;
  });
}

/** Marks a connection as signed in again (or deleted). */
export function clearAuthNeeded(profileId: string) {
  if (!needed.has(profileId)) return;
  const next = new Set(needed);
  next.delete(profileId);
  set(next);
}

/** The connections that need signing in again. */
export function useAuthNeeded(): Set<string> {
  start();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => needed,
  );
}
