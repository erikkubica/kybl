/** A custom action's output as it comes: stdout, stderr (red) and the app's own notes; Copy, Stop. */
import { useLayoutEffect, useRef, useState } from "react";
import { Modal } from "../components/Dialogs";
import { Icon } from "../Icons";
import { useStore } from "../store";
import { runsStore, type Run } from "./customActions";
import "./actions.css";

function statusOf(r: Run): { text: string; tone: "run" | "ok" | "bad" | "dim" } {
  const secs = r.finished ? Math.max(0, Math.round((r.finished - r.started) / 100) / 10) : null;
  const took = secs != null ? ` · ${secs < 60 ? `${secs} s` : `${Math.round(secs / 60)} min`}` : "";
  switch (r.state) {
    case "preparing":
      return { text: r.status ?? "Starting…", tone: "run" };
    case "running":
      return { text: "Running…", tone: "run" };
    case "done":
      return { text: `Exit code 0${took}`, tone: "ok" };
    case "stopped":
      return { text: `Stopped${took}`, tone: "dim" };
    default:
      return { text: r.error ? "Couldn’t run" : `Exit code ${r.code ?? "unknown"}${took}`, tone: "bad" };
  }
}

export function OutputSheet({ runId, onClose, onStop }: { runId: string; onClose: () => void; onStop: () => void }) {
  const run = useStore(runsStore, (all) => all[runId]);
  const pre = useRef<HTMLPreElement>(null);
  /** follow the end while the view is at the bottom; scrolling up holds it */
  const follow = useRef(true);
  const [copied, setCopied] = useState(false);

  useLayoutEffect(() => {
    const el = pre.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [run?.segments]);

  if (!run) return null;
  const st = statusOf(run);
  const live = run.state === "preparing" || run.state === "running";
  const text = run.segments.map((s) => s.t).join("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* no clipboard: nothing to say */
    }
  };

  return (
    <Modal title={run.name} onClose={onClose} width={640}>
      <div className="modal-body ca-out-body">
        <div className="ca-out-meta">
          <span>
            {run.items === 1 ? "1 item" : `${run.items.toLocaleString()} items`} {run.where}
            {run.commands > 1 ? ` · ${run.commands} commands` : ""}
          </span>
          <span className={`ca-out-status ${st.tone}`}>
            {live && <span className="spinner" aria-hidden="true" />}
            {st.text}
          </span>
        </div>
        <pre
          ref={pre}
          className="ca-out selectable"
          tabIndex={0}
          aria-label="Output"
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {run.segments.map((s, i) => (
            <span key={i} className={`ca-s-${s.s}`}>
              {s.t}
            </span>
          ))}
          {!text && <span className="ca-s-note">{live ? "Waiting for output…" : run.error ? "" : "No output."}</span>}
          {run.error && <span className="ca-s-err">{run.error}</span>}
        </pre>
        {run.truncated && <p className="hint">Only the first 1 MB of output is shown.</p>}
      </div>
      <div className="modal-foot split">
        <button className="btn btn-sm" onClick={copy} disabled={!text}>
          <Icon name={copied ? "check" : "copy"} size={13} /> {copied ? "Copied" : "Copy"}
        </button>
        <div className="btn-row">
          {live && (
            <button className="btn btn-sm btn-danger-ghost" onClick={onStop}>
              Stop
            </button>
          )}
          <button className="btn btn-sm btn-primary" onClick={onClose} data-autofocus>
            {live ? "Hide" : "Close"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
