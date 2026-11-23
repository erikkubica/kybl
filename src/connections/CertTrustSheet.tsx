/**
 * Trusting a server's own TLS certificate (FTPS, WebDAV over https), as FileZilla does. The
 * folder error and the connection dialog's test result offer "Trust this certificate…"; this
 * sheet shows what the certificate says before the user decides. "changed": another certificate
 * was trusted before, which is what an interception looks like, so (as with SFTP host keys) not
 * connecting is the default and trusting the new one takes a deliberate click.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../Icons";
import { Modal } from "../components/Dialogs";
import { errMessage } from "../api";
import type { CertTrouble } from "./kinds";
import "./connections.css";

/** "20 Nov 2036" from "2036-11-20" (the certificate's dates are UTC days). */
function day(d: string | null): string | null {
  if (!d) return null;
  const t = new Date(`${d}T00:00:00Z`);
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** What's wrong with it, in sentences (as the Rust side words them). */
export function certReasons(c: CertTrouble, host: string): string[] {
  return c.reasons.map((r) => {
    switch (r) {
      case "self-signed":
        return "The server signed it itself.";
      case "unknown-issuer":
        return "It isn't from an authority Kybl knows.";
      case "wrong-name":
        return c.name ? `It's made out to ${c.name}, not ${host}.` : `It isn't made out to ${host}.`;
      case "expired":
        return `It expired on ${day(c.validUntil) ?? "an earlier date"}.`;
      case "not-yet-valid":
        return `It isn't valid until ${day(c.validFrom) ?? "a later date"}.`;
      default:
        return "It didn't pass the usual checks.";
    }
  });
}

function Details({ cert, host }: { cert: CertTrouble; host: string }) {
  return (
    <dl className="cert-details">
      {cert.name && (
        <>
          <dt>Made out to</dt>
          <dd className="selectable">{cert.name}</dd>
        </>
      )}
      {cert.issuer && (
        <>
          <dt>Issued by</dt>
          <dd className="selectable">{cert.issuer}</dd>
        </>
      )}
      {cert.validUntil && (
        <>
          <dt>Valid until</dt>
          <dd>{day(cert.validUntil)}</dd>
        </>
      )}
      <dt>Problem</dt>
      <dd>{certReasons(cert, host).join(" ")}</dd>
    </dl>
  );
}

export function CertTrustSheet({ cert, host, onTrust, onClose }: { cert: CertTrouble; host: string; onTrust: (fp: string) => void; onClose: () => void }) {
  if (cert.kind === "untrusted") {
    return (
      <Modal title="Trust this certificate?" onClose={onClose} width={480}>
        <div className="modal-body hostkey">
          <p>
            <strong>{host}</strong> answered with a certificate Kybl can't check. That's normal for a server with its own certificate, like a NAS or a small web host. Its fingerprint:
          </p>
          <code className="hostkey-fp selectable">{cert.fp}</code>
          <Details cert={cert} host={host} />
          <p className="hint">
            <Icon name="info" size={13} />
            <span>Trust it only if you know this server; if you can, compare the fingerprint with the one it shows. Kybl remembers it for this connection and warns you if it ever changes.</span>
          </p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onTrust(cert.fp)} data-autofocus>
            Trust and connect
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title="The server's certificate changed"
      onClose={onClose}
      width={500}
      icon={
        <div className="confirm-icon" aria-hidden="true">
          <Icon name="alert" size={19} />
        </div>
      }
    >
      <div className="modal-body hostkey">
        <p>
          <strong>{host}</strong> answered with a different certificate than the one you trusted. Someone may be intercepting the connection, so Kybl didn't connect.
        </p>
        <dl className="hostkey-cmp">
          <dt>Trusted before</dt>
          <dd>
            <code className="selectable">{cert.saved}</code>
          </dd>
          <dt>Now</dt>
          <dd>
            <code className="selectable">{cert.fp}</code>
          </dd>
        </dl>
        <Details cert={cert} host={host} />
        <p className="hint">
          <Icon name="info" size={13} />
          <span>Trust the new one only if you know why it changed, for example because the certificate was renewed. When in doubt, ask whoever runs the server.</span>
        </p>
      </div>
      <div className="modal-foot">
        <button type="button" className="btn btn-danger-ghost" onClick={() => onTrust(cert.fp)}>
          Trust the new certificate
        </button>
        <button type="button" className="btn btn-primary" onClick={onClose} data-autofocus>
          Don't connect
        </button>
      </div>
    </Modal>
  );
}

/**
 * "Trust this certificate…" under an error, and the sheet it opens. `onTrust` saves the
 * fingerprint and connects again; while it runs the button waits, and its error shows instead.
 */
export function TrustCertButton({
  cert,
  host,
  onTrust,
  className = "btn btn-sm",
}: {
  cert: CertTrouble;
  host: string;
  onTrust: (fp: string) => Promise<void> | void;
  className?: string;
}) {
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
        {busy ? <span className="spinner" /> : <Icon name={cert.kind === "changed" ? "alert" : "check-circle"} size={13} />}
        {cert.kind === "changed" ? "Check the new certificate…" : "Trust this certificate…"}
      </button>
      {failed && (
        <span className="cert-failed" role="alert">
          {failed}
        </span>
      )}
      {/* outside any dialog box: a fixed sheet inside an animated, scrolling body would be clipped */}
      {open && createPortal(<CertTrustSheet cert={cert} host={host} onTrust={(fp) => void trust(fp)} onClose={() => setOpen(false)} />, document.querySelector(".m-app") ?? document.body)}
    </>
  );
}
