/**
 * SFTP trust on first use. "unknown": Kybl hasn't seen this server, show its fingerprint and ask.
 * "changed": the server's key differs from the one trusted before, which is what an interception
 * looks like, so the safe answer is the default and replacing the key takes a deliberate click.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../ui/components/Icons";
import { Modal } from "../../ui/components/Dialogs";
import { errMessage } from "../../core/api";
import type { HostKeyAsk } from "../lib/connTrouble";

export type { HostKeyAsk } from "../lib/connTrouble";

/**
 * From a folder's error: "Trust this server…" (first connection) or "Check the new key…" (it
 * changed), opening the same sheet the connection dialog shows. `onTrust` saves the key.
 */
export function TrustHostKeyButton({ ask, onTrust, className = "btn btn-sm" }: { ask: HostKeyAsk; onTrust: (fp: string) => Promise<void> | void; className?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const trust = async (fp: string) => {
    setOpen(false);
    setBusy(true);
    setFailed(null);
    try {
      await onTrust(fp);
    } catch (e) {
      setFailed(errMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} disabled={busy}>
        {busy ? <span className="spinner" /> : <Icon name={ask.kind === "changed" ? "alert" : "check-circle"} size={13} />}
        {ask.kind === "changed" ? "Check the new key…" : "Trust this server…"}
      </button>
      {failed && (
        <span className="cert-failed" role="alert">
          {failed}
        </span>
      )}
      {open && createPortal(<HostKeySheet ask={ask} onTrust={(fp) => void trust(fp)} onClose={() => setOpen(false)} />, document.querySelector(".m-app") ?? document.body)}
    </>
  );
}

export function HostKeySheet({ ask, onTrust, onClose }: { ask: HostKeyAsk; onTrust: (fp: string) => void; onClose: () => void }) {
  if (ask.kind === "unknown") {
    return (
      <Modal title="Trust this server?" onClose={onClose} width={460}>
        <div className="modal-body hostkey">
          <p>
            This is the first time Kybl connects to <strong>{ask.host}</strong>. Servers prove who they are with a key; this is its fingerprint:
          </p>
          <code className="hostkey-fp selectable">{ask.fp}</code>
          <p className="hint">
            <Icon name="info" size={13} />
            <span>
              If you can, compare it with the one your server shows (for example with <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on the server). Kybl remembers it and warns you if it ever changes.
            </span>
          </p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onTrust(ask.fp)} data-autofocus>
            Trust and connect
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title="The server's identity changed"
      onClose={onClose}
      width={480}
      icon={
        <div className="confirm-icon" aria-hidden="true">
          <Icon name="alert" size={19} />
        </div>
      }
    >
      <div className="modal-body hostkey">
        <p>
          <strong>{ask.host}</strong> answered with a different key than the one you trusted. Someone may be intercepting the connection, so Kybl didn't connect.
        </p>
        <dl className="hostkey-cmp">
          <dt>Trusted before</dt>
          <dd>
            <code className="selectable">{ask.saved}</code>
          </dd>
          <dt>Now</dt>
          <dd>
            <code className="selectable">{ask.now}</code>
          </dd>
        </dl>
        <p className="hint">
          <Icon name="info" size={13} />
          <span>Replace the saved key only if you know why it changed, for example because the server was reinstalled. When in doubt, ask whoever runs it.</span>
        </p>
      </div>
      <div className="modal-foot">
        <button type="button" className="btn btn-danger-ghost" onClick={() => onTrust(ask.now)}>
          Replace saved key
        </button>
        <button type="button" className="btn btn-primary" onClick={onClose} data-autofocus>
          Don't connect
        </button>
      </div>
    </Modal>
  );
}
