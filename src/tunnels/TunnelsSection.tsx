/**
 * The SFTP connection form's "Tunnels" tab: local port forwards through
 * the server, each `local port → host:port` as the server sees it, with an optional name and
 * "Start when the connection opens". A local port that something else already uses is a warning
 * (it may be free again by the time the tunnel starts); everything else must be right to save.
 */
import { useEffect, useState } from "react";
import { Icon } from "../Icons";
import { RAW } from "../connections/fields";
import type { TunnelDef } from "../types";
import { tunnelApi, useConnectionTunnels } from "./tunnels";
import "./tunnels.css";

type RowProblems = { local?: string; host?: string; remote?: string };

const portOk = (n: number) => Number.isInteger(n) && n > 0 && n < 65536;

/** What's wrong with each tunnel (by index); empty when all can be saved. */
export function tunnelProblems(tunnels: TunnelDef[]): RowProblems[] {
  return tunnels.map((t, i) => {
    const p: RowProblems = {};
    if (!portOk(t.localPort)) p.local = "Local port: 1 to 65535.";
    else if (tunnels.findIndex((o) => o.localPort === t.localPort) < i) p.local = `Port ${t.localPort} is used by another tunnel above.`;
    const host = t.remoteHost.trim();
    if (!host) p.host = "Enter the host to reach, as the server sees it (often localhost).";
    else if (/[\s/]/.test(host)) p.host = `“${host}” isn't a host name or address.`;
    // one colon is a pasted "host:port" (an IPv6 address has at least two)
    // so is "[::1]:5432", an IPv6 address in brackets with its port
    else if (host.split(":").length === 2 || (host.startsWith("[") && !host.endsWith("]"))) p.host = "Put the port in the Remote port box.";
    if (!portOk(t.remotePort)) p.remote = "Remote port: 1 to 65535.";
    return p;
  });
}

/** The first problem, for the form's check before saving. */
export function tunnelProblem(tunnels: TunnelDef[]): string | null {
  for (const p of tunnelProblems(tunnels)) {
    const m = p.local ?? p.host ?? p.remote;
    if (m) return m;
  }
  return null;
}

/** Tunnels as they are saved: trimmed, brackets off an IPv6 host. */
export function tidyTunnels(tunnels: TunnelDef[]): TunnelDef[] {
  return tunnels.map((t) => ({ ...t, name: t.name.trim(), remoteHost: t.remoteHost.trim().replace(/^\[(.*)\]$/, "$1") }));
}

// a new tunnel gets its id here: rows keep their identity, and the port check can tell its own
const blank = (): TunnelDef => ({ id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: "", localPort: 0, remoteHost: "localhost", remotePort: 0, autoStart: false });
const num = (s: string) => (s.trim() ? Number(s.replace(/[^\d]/g, "")) || 0 : 0);

export function TunnelsSection({
  profileId,
  tunnels,
  tried,
  onChange,
}: {
  /** the saved connection's id ("" while new): its own running tunnels don't count as "port taken" */
  profileId: string;
  tunnels: TunnelDef[];
  tried: boolean;
  onChange: (t: TunnelDef[]) => void;
}) {
  // a tunnel just added takes the keyboard at its local port
  const [added, setAdded] = useState<string | null>(null);
  const problems = tunnelProblems(tunnels);
  const set = (i: number, patch: Partial<TunnelDef>) => onChange(tunnels.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const add = () => {
    const t = blank();
    setAdded(t.id);
    onChange([...tunnels, t]);
  };

  return (
    <div className="tunnels">
      <p className="hint">Reach a database or admin panel only the server can see, as a port on this computer.</p>
      {tunnels.map((t, i) => (
        <TunnelRow key={t.id || i} t={t} focus={t.id === added} profileId={profileId} problems={tried ? problems[i] : {}} onChange={(patch) => set(i, patch)} onRemove={() => onChange(tunnels.filter((_, j) => j !== i))} />
      ))}
      <button type="button" className="btn btn-sm btn-ghost tunnels-add" onClick={add}>
        <Icon name="plus" size={13} /> Add tunnel
      </button>
    </div>
  );
}

function TunnelRow({
  t,
  focus,
  profileId,
  problems,
  onChange,
  onRemove,
}: {
  t: TunnelDef;
  focus: boolean;
  profileId: string;
  problems: RowProblems;
  onChange: (p: Partial<TunnelDef>) => void;
  onRemove: () => void;
}) {
  const taken = usePortTaken(t.localPort, profileId, t.id);
  const err = problems.local ?? problems.host ?? problems.remote;
  // live: a tunnel started or stopped (autostart, a drop) while the form is open shows here
  const live = useConnectionTunnels(profileId);
  const running = !!(t.id && profileId && live.some((x) => x.tunnelId === t.id));
  return (
    <div className="tunnel-edit" role="group" aria-label={t.name || "Tunnel"}>
      <div className="tunnel-edit-route">
        <span
          className={`tunnel-state${running ? " on" : ""}`}
          role="img"
          aria-label={running ? "Running" : "Not running"}
          title={running ? "Running now. Saving a new port or address stops it." : "Not running"}
        />
        <div className={`tunnel-route${err ? " bad" : ""}`} role="group" aria-label="Local port to remote host and port">
          <input
            className="mono tunnel-port"
            aria-label="Local port"
            autoFocus={focus}
            title="The port on this computer (127.0.0.1) that apps connect to"
            value={t.localPort || ""}
            onChange={(e) => onChange({ localPort: num(e.target.value) })}
            placeholder="5433"
            inputMode="numeric"
            aria-invalid={!!problems.local}
            {...RAW}
          />
          <span className="tunnel-arrow" aria-hidden="true">
            →
          </span>
          <input
            className="mono tunnel-host"
            aria-label="Remote host, as the server sees it"
            title="Where the server connects to: localhost is the server itself"
            value={t.remoteHost}
            onChange={(e) => onChange({ remoteHost: e.target.value })}
            placeholder="localhost"
            inputMode="url"
            aria-invalid={!!problems.host}
            {...RAW}
          />
          <span className="tunnel-colon" aria-hidden="true">
            :
          </span>
          <input
            className="mono tunnel-port"
            aria-label="Remote port"
            value={t.remotePort || ""}
            onChange={(e) => onChange({ remotePort: num(e.target.value) })}
            placeholder="5432"
            inputMode="numeric"
            aria-invalid={!!problems.remote}
            {...RAW}
          />
        </div>
        <button type="button" className="icon-btn tunnel-remove" onClick={onRemove} title="Remove this tunnel" aria-label="Remove this tunnel">
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="tunnel-edit-more">
        <input className="tunnel-name-input" aria-label="Tunnel name" value={t.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Name" {...RAW} />
        <label className="check tunnel-auto" title="Starts when Kybl opens this connection">
          <input type="checkbox" checked={t.autoStart} onChange={(e) => onChange({ autoStart: e.target.checked })} />
          <span>Auto-start</span>
        </label>
      </div>
      {err ? (
        <em className="field-err">{err}</em>
      ) : taken ? (
        <small className="tunnel-warn">
          <Icon name="alert" size={12} /> {taken}
        </small>
      ) : null}
    </div>
  );
}

/** Why the local port can't be used now (asked a moment after typing stops), or null. */
function usePortTaken(port: number, profileId: string, tunnelId: string): string | null {
  const [taken, setTaken] = useState<{ port: number; why: string | null } | null>(null);
  useEffect(() => {
    if (!portOk(port)) return;
    let live = true;
    const t = window.setTimeout(() => {
      tunnelApi
        .portCheck(port, profileId, tunnelId)
        .then((why) => live && setTaken({ port, why }))
        .catch(() => live && setTaken(null));
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [port, profileId, tunnelId]);
  return taken?.port === port ? taken.why : null;
}
