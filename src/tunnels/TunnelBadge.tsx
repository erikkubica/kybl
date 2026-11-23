/**
 * The sidebar's mark on a connection with SSH tunnels running (a small tunnel, with the count when
 * more than one; amber while one signs in again), and the popover it opens: each tunnel's local
 * address (a click copies it), its connections and bytes, and Stop. The connection's other
 * tunnels are listed below with Start.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../Icons";
import { formatBytes } from "../format";
import type { Profile, TunnelDef } from "../types";
import {
  copyAddress,
  hostPort,
  localAddress,
  reloadTunnels,
  startTunnel,
  stopTunnel,
  tunnelLabel,
  tunnelsOf,
  useConnectionTunnels,
  useTunnels,
  type TunnelInfo,
} from "./tunnels";
import "./tunnels.css";

const WIDTH = 320;
const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export function TunnelBadge({ p }: { p: Profile }) {
  const running = useConnectionTunnels(p.id);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (!running.length && !anchor) return null;
  const retrying = running.some((t) => t.phase === "retrying");
  const n = running.length;
  const title = retrying
    ? "A tunnel lost the server and is reconnecting"
    : n === 1
      ? `Tunnel ${localAddress(running[0].localPort)} → ${hostPort(running[0].remoteHost, running[0].remotePort)}`
      : `${n} tunnels running`;
  return (
    <>
      {n > 0 && (
        <button
          type="button"
          className={`tunnel-badge${retrying ? " retrying" : ""}`}
          title={title}
          aria-label={`${title}. Show tunnels`}
          aria-haspopup="dialog"
          onClick={(e) => {
            e.stopPropagation();
            setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect());
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Icon name="tunnel" size={12} />
          {n > 1 && <span>{n}</span>}
        </button>
      )}
      {anchor && createPortal(<TunnelPopover p={p} anchor={anchor} onDismiss={() => setAnchor(null)} />, document.body)}
    </>
  );
}

export function TunnelPopover({ p, anchor, onDismiss }: { p: Profile; anchor: DOMRect; onDismiss: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const { running: all } = useTunnels();
  const running = all.filter((t) => t.profileId === p.id);
  const stopped = tunnelsOf(p).filter((d) => !running.some((t) => t.tunnelId === d.id));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  // bytes move without events: read them again while it is open
  useEffect(() => {
    const t = window.setInterval(() => void reloadTunnels(), 1000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element;
      if (box.current?.contains(t) || t.closest?.(".tunnel-badge")) return;
      dismiss.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      dismiss.current();
    };
    // one handler for add and remove (dismiss.current is replaced on every render)
    const resize = () => dismiss.current();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", resize);
    box.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", resize);
    };
  }, []);
  // the last one stopped and nothing is left to start: nothing to show
  useEffect(() => {
    if (!running.length && !stopped.length) dismiss.current();
  }, [running.length, stopped.length]);

  const act = async (id: string, f: () => Promise<unknown>) => {
    setBusy(id);
    setErrors(({ [id]: _, ...rest }) => rest);
    try {
      await f();
    } catch (e) {
      setErrors((x) => ({ ...x, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };
  const copy = async (port: number) => {
    if (await copyAddress(port)) {
      setCopied(port);
      window.setTimeout(() => setCopied((c) => (c === port ? null : c)), 1400);
    }
  };

  const left = Math.max(8, Math.min(window.innerWidth - WIDTH - 8, anchor.left - 8));
  // under the mark, or above it when there's no room below (a connection low in the sidebar)
  const [top, setTop] = useState(anchor.bottom + 6);
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 0;
    setTop(anchor.bottom + 6 + h <= window.innerHeight - 8 ? anchor.bottom + 6 : Math.max(8, anchor.top - 6 - h));
  }, [anchor, running.length, stopped.length]);
  return (
    <div
      className="tunnel-pop"
      ref={box}
      role="dialog"
      tabIndex={-1}
      aria-label={`Tunnels of ${p.name}`}
      style={{ left, top, width: WIDTH }}
      // React passes events up through the portal: the sidebar row it opened from mustn't get them
      onClick={stop}
      onDoubleClick={stop}
      onKeyDown={stop}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="tunnel-pop-head">
        <Icon name="tunnel" size={13} />
        <span>Tunnels · {p.name}</span>
      </div>
      {running.map((t) => (
        <Running key={t.tunnelId} t={t} copied={copied === t.localPort} busy={busy === t.tunnelId} error={errors[t.tunnelId]} onCopy={() => void copy(t.localPort)} onStop={() => void act(t.tunnelId, () => stopTunnel(p.id, t.tunnelId))} />
      ))}
      {stopped.length > 0 && running.length > 0 && <div className="tunnel-pop-sep" />}
      {stopped.map((d) => (
        <Stopped key={d.id} d={d} busy={busy === d.id} error={errors[d.id]} onStart={() => void act(d.id, () => startTunnel(p.id, d.id))} />
      ))}
    </div>
  );
}

function Running({ t, copied, busy, error, onCopy, onStop }: { t: TunnelInfo; copied: boolean; busy: boolean; error?: string; onCopy: () => void; onStop: () => void }) {
  const conns = t.active === 1 ? "1 connection" : `${t.active} connections`;
  const note = error ?? t.error;
  return (
    <div className={`tunnel-row${t.phase === "retrying" ? " retrying" : ""}`}>
      <span className="tunnel-dot" aria-hidden="true" />
      <div className="tunnel-main">
        <div className="tunnel-name" title={t.name}>
          {t.name}
        </div>
        <button type="button" className="tunnel-addr mono" onClick={onCopy} title="Copy the address">
          {copied ? "Copied" : localAddress(t.localPort)}
          <Icon name={copied ? "check" : "copy"} size={11} />
        </button>
        <span className="tunnel-to mono" title={`Through the server to ${hostPort(t.remoteHost, t.remotePort)}`}>
          → {hostPort(t.remoteHost, t.remotePort)}
        </span>
        <div className="tunnel-stats">
          {t.phase === "retrying" ? "Reconnecting…" : conns}
          {t.total > 0 && ` · ↑ ${formatBytes(t.sent)} ↓ ${formatBytes(t.received)}`}
        </div>
        {note && <div className="tunnel-note">{note}</div>}
      </div>
      <button type="button" className="btn btn-sm" onClick={onStop} disabled={busy}>
        Stop
      </button>
    </div>
  );
}

function Stopped({ d, busy, error, onStart }: { d: TunnelDef; busy: boolean; error?: string; onStart: () => void }) {
  return (
    <div className="tunnel-row off">
      <span className="tunnel-dot" aria-hidden="true" />
      <div className="tunnel-main">
        <div className="tunnel-name" title={tunnelLabel(d)}>
          {tunnelLabel(d)}
        </div>
        <span className="tunnel-to mono">
          {d.localPort} → {hostPort(d.remoteHost, d.remotePort)}
        </span>
        {error && <div className="tunnel-note">{error}</div>}
      </div>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onStart} disabled={busy}>
        {busy ? <span className="spinner" /> : "Start"}
      </button>
    </div>
  );
}
