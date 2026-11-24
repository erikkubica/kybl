import { useCallback, useEffect, useRef, useState } from "react";
import { message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errMessage } from "../api";
import { Icon } from "../Icons";
import { ON_PHONE, THIS_DEVICE, kyblApi, saveAppUrl, savedAppUrl, type DeviceStart } from "../kybl";
import type { Profile } from "../types";
import { Modal } from "./Dialogs";
import { ErrorText } from "./ErrorText";
import { ProviderBadge } from "./Sidebar";

type Step =
  | { kind: "idle" }
  | { kind: "browser" }
  | { kind: "device-loading" }
  | { kind: "device"; d: DeviceStart; until: number };

const newFlowId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/**
 * Signs in to Kybl Storage: approve this computer in the browser (or with a code on another
 * device) and the app receives its own access key. Nobody types or copies keys.
 *
 * `existing` is a Kybl connection being edited; `reconnect` starts straight away with a new key
 * for it (its old one was revoked).
 */
export function KyblConnectDialog({
  existing,
  reconnect,
  onConnected,
  onDeleted,
  onClose,
}: {
  existing?: Profile | null;
  reconnect?: boolean;
  onConnected: (p: Profile) => void;
  onDeleted?: (id: string) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [defaultUrl, setDefaultUrl] = useState("");
  const [url, setUrl] = useState(savedAppUrl() ?? "");
  const [showServer, setShowServer] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const [now, setNow] = useState(Date.now());
  const flow = useRef<string | null>(null);

  useEffect(() => {
    kyblApi.defaultAppUrl().then(setDefaultUrl, () => {});
  }, []);

  const stop = useCallback(() => {
    if (flow.current) kyblApi.cancel(flow.current).catch(() => {});
    flow.current = null;
  }, []);
  // closing the dialog stops the listener or the polling
  useEffect(() => stop, [stop]);

  const close = () => {
    stop();
    onClose();
  };

  const done = (p: Profile) => {
    flow.current = null;
    onConnected(p);
    onClose();
  };

  const failed = (id: string, e: unknown) => {
    if (flow.current !== id) return; // cancelled or replaced
    flow.current = null;
    const msg = errMessage(e);
    setStep({ kind: "idle" });
    if (msg !== "Cancelled") setError(msg);
  };

  const startBrowser = () => {
    stop();
    const id = newFlowId();
    flow.current = id;
    setError(null);
    setStep({ kind: "browser" });
    kyblApi.connectBrowser(id, existing?.id).then(done, (e) => failed(id, e));
  };

  const startDevice = async () => {
    stop();
    const id = newFlowId();
    flow.current = id;
    setError(null);
    setStep({ kind: "device-loading" });
    try {
      const d = await kyblApi.deviceStart();
      if (flow.current !== id) return;
      setNow(Date.now());
      setStep({ kind: "device", d, until: Date.now() + d.expiresIn * 1000 });
      kyblApi.deviceWait(id, d, existing?.id).then(done, (e) => failed(id, e));
    } catch (e) {
      failed(id, e);
    }
  };

  // "Connect again" on a revoked key goes straight to the browser
  const auto = useRef(false);
  useEffect(() => {
    if (reconnect && !auto.current) {
      auto.current = true;
      startBrowser();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnect]);

  useEffect(() => {
    if (step.kind !== "device") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [step.kind]);

  const saveServer = () => {
    const v = url.trim().replace(/\/+$/, "");
    saveAppUrl(v && v !== defaultUrl ? v : null);
    setUrl(v && v !== defaultUrl ? v : "");
    setShowServer(false);
    if (step.kind !== "idle") {
      // restart against the new server
      if (step.kind === "browser") startBrowser();
      else startDevice();
    }
  };

  const remove = async () => {
    if (!existing || removing) return;
    setRemoving(true);
    let note: string | null;
    try {
      note = await api.deleteProfile(existing.id);
    } catch (e) {
      setError(`Couldn’t remove this connection.\n\n${errMessage(e)}`);
      setConfirmDelete(false);
      setRemoving(false);
      return;
    }
    // removed; a note says its saved key is only cleared at the next start
    stop();
    onDeleted?.(existing.id);
    onClose();
    if (note) void message(note, { title: "Connection removed", kind: "warning" }).catch(() => {});
  };

  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const copyCode = (code: string) => {
    const flash = (v: "yes" | "failed") => {
      setCopied(v);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), v === "yes" ? 1500 : 4000);
    };
    const write = navigator.clipboard?.writeText(code);
    if (!write) return flash("failed");
    write.then(
      () => flash("yes"),
      () => flash("failed"),
    );
  };

  const server = savedAppUrl() || defaultUrl;
  const left = step.kind === "device" ? Math.max(0, Math.round((step.until - now) / 1000)) : 0;

  return (
    <Modal title={existing ? "Kybl Storage" : "Connect Kybl Storage"} onClose={close} width={460}>
      <div className="modal-body kybl-connect">
        {existing && (
          <div className="kybl-account">
            <ProviderBadge provider="kybl" large />
            <div>
              <strong>{existing.name}</strong>
              <span className="mono">{existing.endpoint}</span>
            </div>
          </div>
        )}

        {step.kind === "idle" && (
          <>
            {!existing && (
              <div className="kybl-hero">
                <ProviderBadge provider="kybl" large />
                <p>
                  Sign in to Kybl Storage in your browser and approve {THIS_DEVICE}. Kybl gets its own access key, so there is nothing to copy or
                  paste.
                </p>
              </div>
            )}
            {existing && (
              <p className="hint">
                <Icon name="info" size={13} />
                Connecting again gives {THIS_DEVICE} a fresh access key. You can revoke keys on the Access keys page of your Kybl account.
              </p>
            )}
            <button className="btn btn-primary kybl-big" onClick={startBrowser}>
              <Icon name="link" size={15} /> {existing ? "Connect again in browser" : "Continue in browser"}
            </button>
            <button className="btn btn-ghost btn-sm kybl-alt" onClick={startDevice}>
              Sign in on another device with a code
            </button>
          </>
        )}

        {step.kind === "browser" && (
          <div className="kybl-wait">
            <span className="spinner lg" />
            <strong>Waiting for you to approve in the browser…</strong>
            <p>
              {ON_PHONE
                ? "Sign in on the page that opened and tap Connect. Kybl comes back by itself."
                : "A page opened in your browser. Sign in there and click Connect, then come back here."}
            </p>
            <button className="btn btn-ghost btn-sm" onClick={startDevice}>
              Browser didn’t open? Use a code instead
            </button>
          </div>
        )}

        {step.kind === "device-loading" && (
          <div className="kybl-wait">
            <span className="spinner lg" />
            <strong>Getting a code…</strong>
          </div>
        )}

        {step.kind === "device" && (
          <div className="kybl-device">
            {step.d.qrSvg && <div className="kybl-qr" aria-label="QR code of the sign-in link" dangerouslySetInnerHTML={{ __html: step.d.qrSvg }} />}
            <div className="kybl-device-text">
              <p>
                {ON_PHONE ? "On another device, scan the code or open" : "Scan the code with your phone, or open"}{" "}
                <a
                  href={step.d.verificationUriComplete}
                  onClick={(e) => {
                    e.preventDefault();
                    openUrl(step.d.verificationUriComplete).catch(() => {});
                  }}
                >
                  {step.d.verificationUri.replace(/^https?:\/\//, "")}
                </a>{" "}
                and enter:
              </p>
              <button className="kybl-code mono selectable" onClick={() => copyCode(step.d.userCode)} title="Copy the code">
                {step.d.userCode}
                <Icon name={copied === "yes" ? "check" : "copy"} size={14} />
              </button>
              {copied === "failed" && (
                <p className="hint error" role="alert">
                  Couldn’t copy. Type the code instead.
                </p>
              )}
              <p className="kybl-poll">
                <span className="spinner" /> Waiting for approval · {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="result bad" role="alert">
            <Icon name="alert" size={15} />
            <ErrorText message={error} />
          </div>
        )}

        <div className="kybl-server">
          {showServer ? (
            <div className="kybl-server-edit">
              <input
                className="mono"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={defaultUrl}
                spellCheck={false}
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && saveServer()}
              />
              <button className="btn btn-sm" onClick={saveServer}>
                Save
              </button>
            </div>
          ) : (
            <button className="link-btn" onClick={() => setShowServer(true)} title="The Kybl account site the app signs in with">
              Server: {server.replace(/^https?:\/\//, "")}
            </button>
          )}
        </div>
      </div>
      <div className="modal-foot split">
        <div className="btn-row">
          {existing &&
            (confirmDelete ? (
              <>
                <button className="btn btn-danger" onClick={remove} disabled={removing}>
                  {removing && <span className="spinner" />}
                  {removing ? "Removing…" : "Remove connection"}
                </button>
                {/* focus starts on Keep, so a second Return doesn't remove the connection */}
                <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)} disabled={removing} autoFocus>
                  Keep
                </button>
              </>
            ) : (
              <button
                className="btn btn-danger-ghost"
                onClick={() => {
                  setError(null);
                  setConfirmDelete(true);
                }}
              >
                <Icon name="trash" size={14} /> Remove
              </button>
            ))}
        </div>
        <div className="btn-row">
          {step.kind !== "idle" ? (
            <button
              className="btn"
              onClick={() => {
                stop();
                setStep({ kind: "idle" });
              }}
            >
              Cancel
            </button>
          ) : (
            <button className="btn" onClick={close}>
              Close
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
