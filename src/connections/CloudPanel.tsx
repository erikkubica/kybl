/**
 * Google Drive, OneDrive and Dropbox: no keys to type. "Sign in with …" opens the provider's page
 * in the browser and the connection is saved once the user approves Kybl there. The same panel
 * signs an expired connection in again (`reconnect`), keeping its id.
 */
import { useEffect, useRef, useState } from "react";
import { api, errMessage, oauthBuiltinClients, oauthCancel, oauthStart, type OAuthClient, type OAuthKind } from "../api";
import { Icon } from "../Icons";
import { ProviderBadge } from "../components/Sidebar";
import { ErrorText } from "../components/ErrorText";
import type { Profile } from "../types";
import { SIGN_IN_WITH, kindInfo } from "./kinds";
import { Field, RAW, SecretInput } from "./fields";
import { DeleteControl } from "./DeleteControl";

const newFlowId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/** Where people make their own app, in one line (no links: they open the console they know). */
const OWN_APP_HINT: Record<OAuthKind, string> = {
  gdrive: "In Google Cloud Console, create an OAuth client of type “Desktop app” under APIs & Services › Credentials.",
  onedrive: "In Microsoft Entra, register an app under App registrations as a public client with http://localhost as its redirect.",
  dropbox: "In the Dropbox App Console, create a scoped app with full Dropbox access and use its app key.",
};

export function CloudPanel({
  kind,
  initial,
  reconnect,
  onSaved,
  onDeleted,
  onClose,
  onBack,
}: {
  kind: OAuthKind;
  initial: Profile | null;
  /** start signing in again right away (the connection's sign-in expired) */
  reconnect?: boolean;
  onSaved: (p: Profile) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
  /** back to the list of kinds (new connections only) */
  onBack?: () => void;
}) {
  const info = kindInfo(kind);
  const who = SIGN_IN_WITH[kind];
  const [builtin, setBuiltin] = useState<boolean | null>(null);
  const [ownOpen, setOwnOpen] = useState(!!initial?.cloud?.clientId);
  const [clientId, setClientId] = useState(initial?.cloud?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [name, setName] = useState(initial?.name ?? "");
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flow = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    oauthBuiltinClients()
      .then((m) => live && setBuiltin(!!m?.[kind]))
      // an older backend without the command: let people try their own app
      .catch(() => live && setBuiltin(false));
    return () => {
      live = false;
    };
  }, [kind]);
  // no app of our own in this build: the "own app" fields are the only way in
  useEffect(() => {
    if (builtin === false) setOwnOpen(true);
  }, [builtin]);

  const stop = () => {
    if (flow.current) oauthCancel(flow.current).catch(() => {});
    flow.current = null;
    setWaiting(false);
  };
  // closing the dialog stops the browser sign-in waiting in the background
  useEffect(() => () => void (flow.current && oauthCancel(flow.current).catch(() => {})), []);

  const needsOwn = builtin === false;
  const client: OAuthClient | null = ownOpen && clientId.trim() ? { clientId: clientId.trim(), clientSecret: kind === "gdrive" && clientSecret ? clientSecret : null } : null;
  const canStart = builtin !== null && (!needsOwn || !!client);

  const start = async () => {
    if (!canStart || waiting) return;
    const id = newFlowId();
    flow.current = id;
    setWaiting(true);
    setError(null);
    try {
      let p = await oauthStart(kind, id, client, initial?.id ?? null);
      if (flow.current !== id) return;
      flow.current = null;
      // a name typed while editing wins over the account's
      if (initial && name.trim() && name.trim() !== p.name) p = await api.saveProfile({ ...p, name: name.trim() });
      onSaved(p);
      onClose();
    } catch (e) {
      if (flow.current !== id) return;
      flow.current = null;
      setWaiting(false);
      const msg = errMessage(e);
      if (msg !== "Cancelled") setError(msg);
    }
  };

  const startRef = useRef(start);
  startRef.current = start;
  const autoStarted = useRef(false);
  useEffect(() => {
    if (reconnect && builtin !== null && !autoStarted.current) {
      autoStarted.current = true;
      void startRef.current();
    }
  }, [reconnect, builtin]);

  const saveName = async () => {
    if (!initial || busy) return;
    setBusy("save");
    try {
      const p = await api.saveProfile({ ...initial, name: name.trim() || initial.name });
      onSaved(p);
      onClose();
    } catch (e) {
      setError(errMessage(e));
      setBusy(null);
    }
  };

  return (
    <>
      <form
        id="conn-form"
        className="modal-body form-grid"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (initial) void saveName();
          else void start();
        }}
      >
        <div className="conn-cloud span2">
          <ProviderBadge provider={info.provider} large />
          <div>
            <strong>{initial ? initial.cloud?.accountEmail || initial.name : info.label}</strong>
            <p>
              {initial
                ? reconnect
                  ? `Kybl's access to this ${info.label} account ended. Sign in again to keep using it; favorites and synced folders stay as they are.`
                  : `Signed in to ${info.label}.`
                : `Sign in with your ${who} account in the browser. Kybl gets access to your files there, never your password.`}
            </p>
          </div>
        </div>

        {initial && (
          <Field label="Name" wide>
            {(c) => <input {...c} value={name} onChange={(e) => setName(e.target.value)} placeholder={initial.name} />}
          </Field>
        )}

        {needsOwn && (
          <p className="conn-warn span2 info" role="note">
            <Icon name="info" size={14} />
            <span>This build has no {who} app set up. Enter your own client ID below to sign in.</span>
          </p>
        )}

        {waiting ? (
          <div className="conn-waiting span2" role="status" aria-live="polite">
            <span className="spinner" />
            <div>
              <strong>Finish signing in in your browser</strong>
              <p>Come back here once you've allowed Kybl. This page updates by itself.</p>
            </div>
            <button type="button" className="btn btn-sm" onClick={stop}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-primary conn-signin span2" onClick={start} disabled={!canStart} data-autofocus>
            {builtin === null ? <span className="spinner" /> : <Icon name="external" size={15} />}
            {initial ? `Sign in to ${who} again` : `Sign in with ${who}`}
          </button>
        )}

        <div className="span2 conn-own">
          {!needsOwn && (
            <button type="button" className="conn-disclose" aria-expanded={ownOpen} aria-controls="conn-own-fields" onClick={() => setOwnOpen((v) => !v)}>
              <Icon name="chevron" size={12} className={ownOpen ? "open" : ""} />
              Use your own app (advanced)
            </button>
          )}
          {ownOpen && (
            <div id="conn-own-fields" className="form-grid conn-own-fields">
              <Field label="Client ID" wide={kind !== "gdrive"} hint={OWN_APP_HINT[kind]}>
                {(c) => <input {...c} className="mono" value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={waiting} {...RAW} />}
              </Field>
              {kind === "gdrive" && (
                <Field label="Client secret" optional hint="Google shows one for desktop apps too. It isn't really secret, but it's needed.">
                  {(c) => <SecretInput control={c} value={clientSecret} onChange={setClientSecret} editing={!!initial?.cloud?.clientId} label="client secret" />}
                </Field>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="result span2 bad" role="alert">
            <Icon name="alert" size={15} />
            <ErrorText message={error} />
          </div>
        )}
      </form>
      <div className="modal-foot split">
        <div className="btn-row">
          {initial ? (
            <DeleteControl profile={initial} busy={busy} setBusy={setBusy} onDeleted={onDeleted} onClose={onClose} onError={setError} />
          ) : (
            onBack && (
              <button type="button" className="btn btn-ghost" onClick={onBack} disabled={waiting}>
                <Icon name="arrow-left" size={14} /> All kinds
              </button>
            )
          )}
        </div>
        <div className="btn-row">
          {initial && (
            <button type="submit" form="conn-form" className="btn" disabled={busy !== null || waiting}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
