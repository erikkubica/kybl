/**
 * Adding or editing a connection. New ones start on the kind picker; each kind has its own form
 * (S3 keys, a server's address, a storage account, or a browser sign-in) and they share Test,
 * Save and Delete here. SFTP servers are trusted on first use: a test or save that meets an
 * unknown (or changed) server key asks before going on.
 *
 * On phones the same dialog shows as a bottom sheet (mobile.css restyles `.modal`).
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, errMessage, type OAuthKind } from "../api";
import { Icon } from "../Icons";
import { Modal } from "../components/Dialogs";
import { ErrorText } from "../components/ErrorText";
import type { Profile } from "../types";
import { KINDS, hostKeyChanged, hostKeyUnknown, isOAuthKind, kindInfo, pickOf, type BlobKind, type NetKind, type PickId } from "./kinds";
import { SECRET_NOTE, type Draft, type FormApi } from "./fields";
import { KindPicker } from "./KindPicker";
import { S3Form } from "./S3Form";
import { NetForm } from "./NetForm";
import { BlobForm } from "./BlobForm";
import { CloudPanel } from "./CloudPanel";
import { DeleteControl } from "./DeleteControl";
import { HostKeySheet, type HostKeyAsk } from "./HostKeySheet";
import "./connections.css";

export type ConnectionDialogProps = {
  initial: Profile | null;
  /** switch to "Connect Kybl Storage" (no keys to type); without it the picker leaves Kybl out */
  onKybl?: () => void;
  /** No Kybl Storage connection yet: offer it first, above the other kinds. */
  kyblFirst?: boolean;
  /** Open straight on this kind's form instead of the picker (new connections). */
  startKind?: PickId;
  /** A sign-in connection whose access ended: start signing in again right away. */
  reconnect?: boolean;
  onSaved: (p: Profile) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
};

/** Kinds this version can edit; anything else was saved by a newer Kybl and can only be deleted. */
const editable = (p: Profile) => p.provider === "kybl" || KINDS.some((k) => k.id === (p.kind ?? "s3"));

export function ConnectionDialog({ initial, onSaved, onDeleted, onClose, onKybl, kyblFirst, startKind, reconnect }: ConnectionDialogProps) {
  const [pick, setPick] = useState<PickId | null>(initial ? pickOf(initial) : (startKind ?? null));
  const choose = (id: PickId) => {
    if (id === "kybl") onKybl?.();
    else setPick(id);
  };

  if (initial && !editable(initial)) return <Unsupported profile={initial} onDeleted={onDeleted} onClose={onClose} />;

  if (!pick) {
    return (
      <Modal title="New connection" onClose={onClose} width={560}>
        <KindPicker onPick={choose} kybl={!!onKybl} kyblFirst={!!kyblFirst} />
      </Modal>
    );
  }

  const info = kindInfo(pick);
  const back = initial || startKind ? undefined : () => setPick(null);
  const title = initial ? `Edit ${info.label} connection` : `Add ${info.label}`;

  if (isOAuthKind(pick)) {
    return (
      <Modal title={title} onClose={onClose} width={480}>
        <CloudPanel kind={pick as OAuthKind} initial={initial} reconnect={reconnect} onSaved={onSaved} onDeleted={onDeleted} onClose={onClose} onBack={back} />
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={onClose} width={pick === "s3" ? 560 : 520}>
      {/* a Kybl Storage connection opened here (its own dialog is the usual way) edits as S3 */}
      <KeyedForm key={pick} pick={pick === "kybl" ? "s3" : pick} initial={initial} onSaved={onSaved} onDeleted={onDeleted} onClose={onClose} onBack={back} />
    </Modal>
  );
}

/** The kinds typed into a form (everything but the browser sign-ins), with Test and Save. */
function KeyedForm({
  pick,
  initial,
  onSaved,
  onDeleted,
  onClose,
  onBack,
}: {
  pick: Exclude<PickId, OAuthKind | "kybl">;
  initial: Profile | null;
  onSaved: (p: Profile) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
  onBack?: () => void;
}) {
  const form = useRef<FormApi>(null);
  const formEl = useRef<HTMLFormElement>(null);
  // field messages appear once Save or Test was tried, not while typing the first time
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<"test" | "save" | "delete" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [hostAsk, setHostAsk] = useState<(HostKeyAsk & { then: "test" | "save"; draft: Draft }) | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  useEffect(() => {
    // (set again on mount: development mode mounts effects twice)
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // On small screens the result lands below the fold; bring it into view.
  useEffect(() => {
    if (result) resultRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [result]);

  /** The filled-in connection, or null after pointing at the first field that needs work. */
  const draft = (): Draft | null => {
    setTried(true);
    const d = form.current?.draft() ?? null;
    if (!d) requestAnimationFrame(() => formEl.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
    return d;
  };

  const hostOf = (p: Profile) => p.net?.host || p.name;

  const run = async (what: "test" | "save", d: Draft) => {
    setBusy(what);
    setResult(null);
    try {
      // an SFTP server nobody trusted yet would fail on first use: meet its key here instead
      if (what === "test" || (d.profile.kind === "sftp" && !d.profile.net?.hostKey)) {
        const text = await api.testConnection(d.profile, d.secret);
        if (what === "test") {
          if (live.current) setResult({ ok: true, text });
          return;
        }
      }
      const saved = await api.saveProfile(d.profile, d.secret);
      onSaved(saved);
      onClose();
    } catch (e) {
      if (!live.current) return;
      const msg = errMessage(e);
      const fp = hostKeyUnknown(msg);
      const changed = hostKeyChanged(msg);
      if (fp) setHostAsk({ kind: "unknown", host: hostOf(d.profile), fp, then: what, draft: d });
      else if (changed) setHostAsk({ kind: "changed", host: hostOf(d.profile), now: changed.now, saved: changed.saved, then: what, draft: d });
      else setResult({ ok: false, text: msg });
    } finally {
      if (live.current) setBusy((b) => (b === what ? null : b));
    }
  };

  const test = () => {
    if (busy) return;
    const d = draft();
    if (d) void run("test", d);
  };
  const save = () => {
    if (busy) return;
    const d = draft();
    if (d) void run("save", d);
  };

  const trust = (fp: string) => {
    if (!hostAsk) return;
    const { then, draft: d } = hostAsk;
    setHostAsk(null);
    form.current?.setHostKey?.(fp);
    const net = d.profile.net ? { ...d.profile.net, hostKey: fp } : d.profile.net;
    void run(then, { ...d, profile: { ...d.profile, net } });
  };

  const onEdit = () => setResult(null);
  const common = { initial, tried, formApi: form, onEdit };

  return (
    <>
      <form
        ref={formEl}
        id="conn-form"
        className="modal-body form-grid"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {pick === "s3" ? (
          <S3Form {...common} />
        ) : pick === "webdav" || pick === "ftp" || pick === "sftp" ? (
          <NetForm kind={pick as NetKind} {...common} />
        ) : (
          <BlobForm kind={pick as BlobKind} {...common} />
        )}

        <p className="hint span2">
          <Icon name="check-circle" size={13} />
          {SECRET_NOTE}
        </p>

        {result && (
          <div ref={resultRef} className={`result span2 ${result.ok ? "ok" : "bad"}`} role={result.ok ? "status" : "alert"}>
            <Icon name={result.ok ? "check-circle" : "alert"} size={15} />
            <ErrorText message={result.text} />
          </div>
        )}
      </form>
      <div className="modal-foot split">
        <div className="btn-row">
          {initial ? (
            <DeleteControl profile={initial} busy={busy} setBusy={setBusy} onDeleted={onDeleted} onClose={onClose} onError={(text) => setResult({ ok: false, text })} />
          ) : (
            onBack && (
              <button type="button" className="btn btn-ghost" onClick={onBack} disabled={busy !== null}>
                <Icon name="arrow-left" size={14} /> All kinds
              </button>
            )
          )}
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={test} disabled={busy !== null}>
            {busy === "test" && <span className="spinner" />}
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
          <button type="submit" form="conn-form" className="btn btn-primary" disabled={busy !== null}>
            {busy === "save" && <span className="spinner" />}
            {busy === "save" ? (pick === "sftp" ? "Connecting…" : "Saving…") : "Save"}
          </button>
        </div>
      </div>
      {/* outside the dialog box: a fixed sheet inside its (animated, scrolling) body would be clipped */}
      {hostAsk && createPortal(<HostKeySheet ask={hostAsk} onTrust={trust} onClose={() => setHostAsk(null)} />, document.querySelector(".m-app") ?? document.body)}
    </>
  );
}

/** A connection a newer Kybl saved: nothing here can edit it, but it can go. */
function Unsupported({ profile, onDeleted, onClose }: { profile: Profile; onDeleted: (id: string) => void; onClose: () => void }) {
  const [busy, setBusy] = useState<"delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Edit connection" onClose={onClose}>
      <div className="modal-body">
        <p>
          <strong>{profile.name}</strong> was made with a newer version of Kybl. Update Kybl to change it.
        </p>
        {error && (
          <div className="result bad" role="alert">
            <Icon name="alert" size={15} />
            <ErrorText message={error} />
          </div>
        )}
      </div>
      <div className="modal-foot split">
        <div className="btn-row">
          <DeleteControl profile={profile} busy={busy} setBusy={setBusy} onDeleted={onDeleted} onClose={onClose} onError={setError} />
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
