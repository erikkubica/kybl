/**
 * SSH tunnels (local port forwards) of SFTP connections: the backend calls (src-tauri/src/tunnels)
 * and one live list of the running ones, kept by `tunnel-status` events.
 *
 * A tunnel listens on 127.0.0.1 only. Its definition is saved in the connection
 * (`net.tunnels`, see TunnelsSection); starting and stopping happen from the sidebar (the
 * connection's menu, its badge) and ⌘K (useTunnelCommands).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createStore, useStore } from "../store";
import { errMessage } from "../api";
import type { Profile, TunnelDef } from "../types";

export type TunnelInfo = {
  profileId: string;
  tunnelId: string;
  /** the name, or where it goes */
  name: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  /** "retrying": the SSH connection dropped and is being made again (the port stays open) */
  phase: "up" | "retrying";
  /** what went wrong last: why signing in again failed, a forward the server refused */
  error: string | null;
  /** connections open now, and since it started */
  active: number;
  total: number;
  sent: number;
  received: number;
  started: number;
};

export const TUNNEL_STATUS_EVENT = "tunnel-status";
/** a "Start when the connection opens" tunnel couldn't start: { profileId, tunnelId, name, error } */
export const TUNNEL_ERROR_EVENT = "tunnel-error";

export const tunnelApi = {
  list: () => invoke<TunnelInfo[]>("tunnel_list"),
  start: (profileId: string, tunnelId: string) => invoke<TunnelInfo>("tunnel_start", { profileId, tunnelId }),
  stop: (profileId: string, tunnelId: string) => invoke<boolean>("tunnel_stop", { profileId, tunnelId }),
  /** why a local port can't be used now (taken by another app or tunnel), or null */
  portCheck: (port: number, profileId?: string | null, tunnelId?: string | null) =>
    invoke<string | null>("tunnel_port_check", { port, profileId: profileId || null, tunnelId: tunnelId || null }),
};

type TunnelData = { running: TunnelInfo[]; starting: string[] };
const store = createStore<TunnelData>({ running: [], starting: [] });
let started = false;
const key = (profileId: string, tunnelId: string) => `${profileId}\u0000${tunnelId}`;

export async function reloadTunnels() {
  try {
    const running = await tunnelApi.list();
    store.set((d) => ({ ...d, running }));
  } catch {
    // a backend without tunnels (phones)
  }
}

/** Keeps the list of running tunnels live (once; the hooks below do it too). */
export function watchTunnels() {
  start();
}

function start() {
  if (started) return;
  started = true;
  void reloadTunnels();
  listen<TunnelInfo[]>(TUNNEL_STATUS_EVENT, (e) => store.set((d) => ({ ...d, running: e.payload }))).catch(() => {});
}

/** Every running tunnel (and the ones starting), live. */
export function useTunnels(): TunnelData {
  start();
  return useStore(store);
}

/** The running tunnels of one connection (a stable empty list when none). */
const NONE: TunnelInfo[] = [];
export function useConnectionTunnels(profileId: string): TunnelInfo[] {
  start();
  const sig = useStore(store, (d) => d.running.filter((t) => t.profileId === profileId).map((t) => `${t.tunnelId}:${t.phase}:${t.active}`).join("|"));
  return sig ? store.get().running.filter((t) => t.profileId === profileId) : NONE;
}

export function runningTunnel(profileId: string, tunnelId: string): TunnelInfo | undefined {
  return store.get().running.find((t) => t.profileId === profileId && t.tunnelId === tunnelId);
}

export function isStarting(profileId: string, tunnelId: string): boolean {
  return store.get().starting.includes(key(profileId, tunnelId));
}

/** The tunnels saved in a connection (SFTP only). */
export function tunnelsOf(p: Profile): TunnelDef[] {
  return p.kind === "sftp" ? (p.net?.tunnels ?? []) : [];
}

/** "db.internal:5432", with an IPv6 address in brackets. */
export function hostPort(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/** What a tunnel is called: its name, or where it goes. */
export function tunnelLabel(t: Pick<TunnelDef, "name" | "remoteHost" | "remotePort">): string {
  return t.name.trim() || hostPort(t.remoteHost, t.remotePort);
}

/** The address apps connect to. */
export const localAddress = (port: number) => `127.0.0.1:${port}`;

/** Starts a tunnel; rejects with the reason in words. */
export async function startTunnel(profileId: string, tunnelId: string): Promise<TunnelInfo> {
  const k = key(profileId, tunnelId);
  store.set((d) => ({ ...d, starting: [...d.starting, k] }));
  try {
    const t = await tunnelApi.start(profileId, tunnelId);
    // the event usually comes first; this covers a backend that sends none
    store.set((d) => ({ ...d, running: d.running.some((x) => x.profileId === profileId && x.tunnelId === tunnelId) ? d.running : [...d.running, t] }));
    return t;
  } catch (e) {
    throw new Error(errMessage(e).split("\n\n")[0]);
  } finally {
    store.set((d) => ({ ...d, starting: d.starting.filter((x) => x !== k) }));
  }
}

export async function stopTunnel(profileId: string, tunnelId: string): Promise<void> {
  await tunnelApi.stop(profileId, tunnelId);
  store.set((d) => ({ ...d, running: d.running.filter((x) => !(x.profileId === profileId && x.tunnelId === tunnelId)) }));
}

export async function copyAddress(port: number): Promise<boolean> {
  const text = localAddress(port);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // no clipboard permission (a page without focus): the old way
    const t = document.createElement("textarea");
    t.value = text;
    t.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand("copy");
    t.remove();
    return ok;
  }
}
