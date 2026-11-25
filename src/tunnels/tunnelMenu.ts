/**
 * Starting and stopping SSH tunnels from the sidebar's connection menu ("Tunnels ▸", each one a
 * toggle) and from ⌘K ("Start tunnel “name”" / "Stop tunnel “name”"). Tunnels that couldn't start
 * on their own when the connection opened are reported as toasts here too.
 */
import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import type { MenuItem } from "../ui/components/Dialogs";
import { PHONE } from "../connections/components/fields";
import { registerCommands } from "../palette/lib/commands";
import type { Profile, TunnelDef } from "../core/types";
import { mayBeBackground } from "../shell/lib/notifications";
import { hostPort, isStarting, localAddress, runningTunnel, startTunnel, stopTunnel, TUNNEL_ERROR_EVENT, tunnelLabel, tunnelsOf, watchTunnels } from "./tunnels";

type Toast = (kind: "success" | "error" | "info", text: string) => void;

/** Starts a stopped tunnel or stops a running one, saying how it went. */
export async function toggleTunnel(p: Profile, d: TunnelDef, toast: Toast, want?: boolean): Promise<void> {
  const name = tunnelLabel(d);
  const on = !!runningTunnel(p.id, d.id);
  if (want === on || isStarting(p.id, d.id)) return;
  try {
    if (on) {
      await stopTunnel(p.id, d.id);
      toast("info", `Stopped the tunnel “${name}”.`);
    } else {
      const t = await startTunnel(p.id, d.id);
      const route = `${localAddress(t.localPort)} → ${hostPort(t.remoteHost, t.remotePort)}`;
      toast("success", d.name.trim() ? `Tunnel “${name}” is on: ${route}` : `Tunnel on: ${route}`);
    }
  } catch (e) {
    toast("error", `Tunnel “${name}”: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The connection menu's "Tunnels ▸" (SFTP connections, on a computer): each saved tunnel as a
 * toggle, and with `onEdit` "Add or edit tunnels…" (the connection's form), so an SFTP connection
 * without any yet still shows where tunnels are made.
 */
export function tunnelMenuItems(p: Profile, toast: Toast, onEdit?: () => void): MenuItem[] {
  const defs = tunnelsOf(p);
  if (PHONE || p.kind !== "sftp" || (!defs.length && !onEdit)) return [];
  const edit: MenuItem[] = onEdit ? [...(defs.length ? [{ type: "sep" as const }] : []), { type: "item", label: defs.length ? "Add or edit tunnels…" : "Add a tunnel…", icon: "plus", onClick: onEdit }] : [];
  return [
    { type: "sep" },
    {
      type: "submenu",
      label: "Tunnels",
      icon: "tunnel",
      items: () => [
        ...defs.map((d) => ({
          type: "item" as const,
          label: `${tunnelLabel(d)}  (${d.localPort})`,
          checked: !!runningTunnel(p.id, d.id),
          disabled: isStarting(p.id, d.id),
          onClick: () => void toggleTunnel(p, d, toast),
        })),
        ...edit,
      ],
    },
  ];
}

/** ⌘K commands for every saved tunnel, and toasts for tunnels that failed to start on their own. */
export function useTunnelCommands(profiles: Profile[], toast: Toast) {
  // the palette asks for its commands when it opens: it reads the latest of both
  const latest = useRef({ profiles, toast });
  latest.current = { profiles, toast };
  useEffect(() => {
    if (PHONE) return;
    // the running list is kept live from now on (the titles say Start or Stop right)
    watchTunnels();
    const off = registerCommands("tunnels", () =>
      latest.current.profiles.flatMap((p) =>
        tunnelsOf(p).map((d) => {
          const on = !!runningTunnel(p.id, d.id);
          const name = tunnelLabel(d);
          return {
            id: `tunnel:${on ? "stop" : "start"}:${p.id}:${d.id}`,
            title: `${on ? "Stop" : "Start"} tunnel “${name}”`,
            group: `Tunnel · ${p.name}`,
            keywords: `ssh port forward ${d.localPort} ${hostPort(d.remoteHost, d.remotePort)} ${p.net?.host ?? ""}`,
            icon: "tunnel" as const,
            run: () => toggleTunnel(p, d, latest.current.toast, !on),
          };
        }),
      ),
    );
    const unlisten = listen<{ name: string; error: string }>(TUNNEL_ERROR_EVENT, (e) =>
      // auto-start and restarts happen by themselves: the bell, unless it answers a click
      mayBeBackground(() => latest.current.toast("error", `Tunnel “${e.payload.name}” didn't start: ${e.payload.error.split("\n\n")[0]}`)),
    );
    return () => {
      off();
      void unlisten.then((f) => f()).catch(() => {});
    };
  }, []);
}
