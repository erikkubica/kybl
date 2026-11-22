/**
 * SFTP trust on first use. "unknown": Kybl hasn't seen this server, show its fingerprint and ask.
 * "changed": the server's key differs from the one trusted before, which is what an interception
 * looks like, so the safe answer is the default and replacing the key takes a deliberate click.
 */
import { Icon } from "../Icons";
import { Modal } from "../components/Dialogs";

export type HostKeyAsk = { kind: "unknown"; host: string; fp: string } | { kind: "changed"; host: string; now: string; saved: string };

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
              If you can, compare it with the one your server shows (for example with <code>ssh-keygen -l</code> on the server). Kybl remembers it and warns you if it ever changes.
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
