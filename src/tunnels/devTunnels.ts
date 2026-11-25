/**
 * The browser mock's SSH tunnel backend (dev only, see devMock.ts): tunnels "start" after a moment,
 * gain and lose made-up connections and bytes, and port 5432 and 3306 count as taken by other apps
 * (so the form's warning and a failed start can be seen). A tunnel named with "flaky" drops and
 * reconnects every so often. "Start when the connection opens" tunnels start on the first
 * list_roots of their connection. `window.__kyblTunnels` holds the running ones.
 */
import { emit } from "@tauri-apps/api/event";
import type { Profile } from "../core/types";
import type { TunnelInfo } from "./tunnels";

const TAKEN = new Set([5432, 3306]);
const running: TunnelInfo[] = [];
const autostarted = new Set<string>();
(window as unknown as { __kyblTunnels: TunnelInfo[] }).__kyblTunnels = running;

const changed = () => void emit("tunnel-status", running.map((t) => ({ ...t })));
const label = (d: { name: string; remoteHost: string; remotePort: number }) => d.name.trim() || `${d.remoteHost}:${d.remotePort}`;

let ticking = false;
function tick() {
  if (ticking) return;
  ticking = true;
  window.setInterval(() => {
    let moved = false;
    for (const t of running) {
      if (t.phase === "retrying") continue;
      // now and then an app connects or lets go
      if (Math.random() < 0.15) {
        const up = t.active < 3 && Math.random() < 0.6;
        t.active = Math.max(0, t.active + (up ? 1 : -1));
        if (up) t.total += 1;
        moved = true;
      }
      if (t.active > 0) {
        t.sent += Math.round(Math.random() * 40_000);
        t.received += Math.round(Math.random() * 400_000);
      }
      if (/flaky/i.test(t.name) && Math.random() < 0.08) {
        Object.assign(t, { phase: "retrying", active: 0, error: "The connection to the server dropped. Reconnecting…" });
        moved = true;
        window.setTimeout(() => {
          Object.assign(t, { phase: "up", error: null });
          changed();
        }, 3500);
      }
    }
    if (moved) changed();
  }, 1000);
}

async function start(profiles: Profile[], profileId: string, tunnelId: string): Promise<TunnelInfo> {
  const have = running.find((t) => t.profileId === profileId && t.tunnelId === tunnelId);
  if (have) return { ...have };
  const p = profiles.find((x) => x.id === profileId);
  const d = p?.net?.tunnels?.find((t) => t.id === tunnelId);
  if (!p || !d) throw "This tunnel isn't in the connection any more.";
  await new Promise((r) => setTimeout(r, 600));
  const other = running.find((t) => t.localPort === d.localPort);
  if (other) throw `Port ${d.localPort} is in use by the tunnel “${other.name}”.`;
  if (TAKEN.has(d.localPort)) throw `Something on this computer already uses port ${d.localPort}.`;
  const t: TunnelInfo = {
    profileId,
    tunnelId,
    name: label(d),
    localPort: d.localPort,
    remoteHost: d.remoteHost,
    remotePort: d.remotePort,
    phase: "up",
    error: null,
    active: 0,
    total: 0,
    sent: 0,
    received: 0,
    started: Date.now(),
  };
  running.push(t);
  tick();
  changed();
  return { ...t };
}

/** The connection opened: its "Start when the connection opens" tunnels start, once. */
export function autostart(profileId: string, profiles: Profile[]) {
  const p = profiles.find((x) => x.id === profileId);
  for (const d of p?.kind === "sftp" ? (p.net?.tunnels ?? []) : []) {
    const k = `${profileId}/${d.id}`;
    if (!d.autoStart || autostarted.has(k)) continue;
    autostarted.add(k);
    start(profiles, profileId, d.id).catch((e) => void emit("tunnel-error", { profileId, tunnelId: d.id, name: label(d), error: String(e) }));
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleTunnel(cmd: string, a: any, profiles: Profile[]): Promise<unknown> {
  switch (cmd) {
    case "tunnel_list":
      return running.map((t) => ({ ...t }));
    case "tunnel_start":
      return start(profiles, a.profileId, a.tunnelId);
    case "tunnel_stop": {
      const i = running.findIndex((t) => t.profileId === a.profileId && t.tunnelId === a.tunnelId);
      if (i < 0) return false;
      running.splice(i, 1);
      changed();
      return true;
    }
    case "tunnel_port_check": {
      const port = Number(a.port);
      const other = running.find((t) => t.localPort === port && !(t.profileId === a.profileId && t.tunnelId === a.tunnelId));
      if (other) return `Port ${port} is in use by the tunnel “${other.name}”.`;
      return TAKEN.has(port) ? `Something on this computer already uses port ${port}.` : null;
    }
    default:
      throw `unknown tunnel command ${cmd}`;
  }
}
