/**
 * Adding or editing a connection. New ones start on the kind picker; each kind has its own form
 * (S3 keys, a server's address, a storage account, or a browser sign-in) and they share Test,
 * Save and Delete here. SFTP servers are trusted on first use: a test or save that meets an
 * unknown (or changed) server key asks before going on. An FTPS or WebDAV server whose own
 * certificate doesn't check out gets "Trust this certificate…" under the test result.
 *
 * On phones the same dialog shows as a bottom sheet (mobile.css restyles `.modal`).
 */
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { api, errMessage, type CloudKind } from "../api";
import { Icon } from "../Icons";
import { Modal } from "../components/Dialogs";
import { ErrorText } from "../components/ErrorText";
import type { Profile } from "../types";
import { KINDS, certTrouble, hostKeyChanged, hostKeyUnknown, isCloudKind, kindInfo, pickOf, type BlobKind, type NetKind, type PickId } from "./kinds";
import { Field, RAW, SECRET_NOTE, Segmented, type Draft, type FormApi } from "./fields";
import { normalizeGroup } from "./groups";
import { KindPicker } from "./KindPicker";
import { S3Form } from "./S3Form";
import { NetForm } from "./NetForm";
import { BlobForm } from "./BlobForm";
import { CloudPanel } from "./CloudPanel";
import { DeleteControl } from "./DeleteControl";
import { HostKeySheet, type HostKeyAsk } from "./HostKeySheet";
import { TrustCertButton } from "./CertTrustSheet";
import "./connections.css";
import { appImageMode, connImageMode, IMAGE_MODES, imageModeLabel, setConnImageMode, setSharedPlaceholders, SHARE_PLACEHOLDERS_TEXT, sharedPlaceholdersOn, type ImageMode } from "../imageMode";

export type ConnectionDialogProps = {
  initial: Profile | null;
  /** switch to "Connect Kybl Storage" (no keys to type); without it the picker leaves Kybl out */
  onKybl?: () => void;
  /** No Kybl Storage connection yet: offer it first, above the other kinds. */
  kyblFirst?: boolean;
  /** Open straight on this kind's form instead of the picker (new connections). */
  startKind?: PickId;
  /** computers: the picker offers "Import connections…" (from FileZilla and other apps) */
  onImport?: () => void;
  /** computers: the sidebar's groups; the form gets a Group field offering them */
  groups?: string[];
  /** A sign-in connection whose access ended: start signing in again right away. */
  reconnect?: boolean;
  onSaved: (p: Profile) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
  /** phones: the system back asks the dialog to close (it may ask about what was typed first) */
  ref?: Ref<ConnectionDialogHandle>;
};

export type ConnectionDialogHandle = {
  /** Closes, asking first when something was typed; a second call while asking keeps editing. */
  requestClose: () => void;
};

/** Kinds this version can edit; anything else was saved by a newer Kybl and can only be deleted. */
const editable = (p: Profile) => p.provider === "kybl" || KINDS.some((k) => k.id === (p.kind ?? "s3"));

export function ConnectionDialog({ initial, onSaved, onDeleted, onClose, onKybl, kyblFirst, startKind, reconnect, onImport, groups, ref }: ConnectionDialogProps) {
  const [pick, setPick] = useState<PickId | null>(initial ? pickOf(initial) : (startKind ?? null));
  // the keyboard follows the step: the form's first field after a kind is chosen, the first kind
  // again after "All kinds" or a discard (the dialog box can stay the same, so it won't refocus by itself)
  const firstPick = useRef(true);
  useEffect(() => {
    if (firstPick.current) {
      firstPick.current = false;
      return;
    }
    const raf = requestAnimationFrame(() => {
      const boxes = document.querySelectorAll<HTMLElement>(".modal-backdrop [role=\"dialog\"]");
      const box = boxes[boxes.length - 1];
      if (!box) return;
      const target = pick
        ? box.querySelector<HTMLElement>('.modal-body input:not(:disabled):not([type="hidden"]):not([type="checkbox"]), .modal-body select:not(:disabled), .modal-body textarea:not(:disabled), .modal-body button:not(:disabled)')
        : box.querySelector<HTMLElement>(".kybl-offer, .kind-tile");
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [pick]);
  const choose = (id: PickId) => {
    dirty.current = false;
    if (id === "kybl") onKybl?.();
    else setPick(id);
  };

  // Something typed into the form: leaving it (close, Escape, back, "All kinds") asks first, so a
  // stray click doesn't throw away a half-filled connection.
  const dirty = useRef(false);
  const [ask, setAsk] = useState<{ then: () => void } | null>(null);
  const guarded = (then: () => void) => () => {
    if (dirty.current) setAsk({ then });
    else then();
  };
  const requestClose = () => {
    if (ask) setAsk(null);
    else guarded(onClose)();
  };
  useImperativeHandle(ref, () => ({ requestClose }));
  const discardAsk = ask && (
    <Modal title={initial ? "Discard your changes?" : "Discard this connection?"} onClose={() => setAsk(null)} width={400}>
      <div className="modal-body">
        <p>What you typed here will be lost.</p>
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={() => setAsk(null)} data-autofocus>
          Keep editing
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            const { then } = ask;
            setAsk(null);
            dirty.current = false;
            then();
          }}
        >
          Discard
        </button>
      </div>
    </Modal>
  );

  if (initial && !editable(initial)) return <Unsupported profile={initial} onDeleted={onDeleted} onClose={onClose} />;

  if (!pick) {
    return (
      <Modal title="New connection" onClose={onClose} width={560}>
        <KindPicker onPick={choose} kybl={!!onKybl} kyblFirst={!!kyblFirst} onImport={onImport} />
      </Modal>
    );
  }

  const info = kindInfo(pick);
  const back = initial || startKind ? undefined : guarded(() => setPick(null));
  const title = initial ? `Edit ${info.label} connection` : `Add ${info.label}`;

  if (isCloudKind(pick)) {
    return (
      <Modal title={title} onClose={onClose} width={480}>
        <CloudPanel kind={pick as CloudKind} initial={initial} reconnect={reconnect} onSaved={onSaved} onDeleted={onDeleted} onClose={onClose} onBack={back} />
      </Modal>
    );
  }

  return (
    <>
      <Modal title={title} onClose={requestClose} width={pick === "s3" ? 560 : 520}>
        {/* a Kybl Storage connection opened here (its own dialog is the usual way) edits as S3 */}
        <KeyedForm
          key={pick}
          pick={pick === "kybl" ? "s3" : pick}
          initial={initial}
          onSaved={onSaved}
          onDeleted={onDeleted}
          onClose={onClose}
          onBack={back}
          onDirty={() => (dirty.current = true)}
          groups={groups}
        />
      </Modal>
      {discardAsk}
    </>
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
  onDirty,
  groups,
}: {
  pick: Exclude<PickId, CloudKind | "kybl">;
  /** the sidebar's groups, offered in the Group field (no field without them: phones) */
  groups?: string[];
  initial: Profile | null;
  onSaved: (p: Profile) => void;
  onDeleted: (id: string) => void;
  /** after saving or deleting (no question about unsaved typing then) */
  onClose: () => void;
  onBack?: () => void;
  /** something was typed */
  onDirty: () => void;
}) {
  const form = useRef<FormApi>(null);
  const formEl = useRef<HTMLFormElement>(null);
  // field messages appear once Save or Test was tried, not while typing the first time
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<"test" | "save" | "delete" | null>(null);
  // a failed test or save keeps what was tried, so trusting a certificate can try it again
  const [result, setResult] = useState<{ ok: boolean; text: string; then?: "test" | "save"; draft?: Draft } | null>(null);
  const [hostAsk, setHostAsk] = useState<(HostKeyAsk & { then: "test" | "save"; draft: Draft }) | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  // how photos show for this connection (kept on this device, applied on Save)
  const [photos, setPhotos] = useState<ImageMode | "app">(() => (initial ? connImageMode(initial.id) ?? "app" : "app"));
  const [sharing, setSharing] = useState(() => (initial ? sharedPlaceholdersOn(initial.id) : false));
  const [group, setGroup] = useState(() => normalizeGroup(initial?.group));
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
    // the forms build the profile afresh: the group comes from here (or stays as it was)
    return d && { ...d, profile: { ...d.profile, group: (groups ? normalizeGroup(group) : normalizeGroup(initial?.group)) || null } };
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
      setConnImageMode(saved.id, photos === "app" ? null : photos);
      setSharedPlaceholders(saved.id, sharing);
      onSaved(saved);
      onClose();
    } catch (e) {
      if (!live.current) return;
      const msg = errMessage(e);
      const fp = hostKeyUnknown(msg);
      const changed = hostKeyChanged(msg);
      if (fp) setHostAsk({ kind: "unknown", host: hostOf(d.profile), fp, then: what, draft: d });
      else if (changed) setHostAsk({ kind: "changed", host: hostOf(d.profile), now: changed.now, saved: changed.saved, then: what, draft: d });
      else setResult({ ok: false, text: msg, then: what, draft: d });
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

  /** "Trust this certificate…": remember it in the form and try again. */
  const trustCert = async (fp: string) => {
    if (!result?.draft || !result.then) return;
    const { then, draft: d } = result;
    form.current?.setCertFingerprint?.(fp);
    onDirty();
    const net = d.profile.net ? { ...d.profile.net, certFingerprint: fp } : d.profile.net;
    await run(then, { ...d, profile: { ...d.profile, net } });
  };
  const cert = result && !result.ok && result.draft?.profile.net ? certTrouble(result.text) : null;

  const onEdit = () => {
    setResult(null);
    onDirty();
  };
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

        {groups && (
          <Field label="Group" optional wide hint="A folder in the sidebar. Use / for a group inside a group, like Clients/Acme.">
            {(c) => (
              <>
                <input
                  {...c}
                  {...RAW}
                  list="conn-groups"
                  value={group}
                  onChange={(e) => {
                    setGroup(e.target.value);
                    onEdit();
                  }}
                  placeholder="None: listed at the top level"
                />
                <datalist id="conn-groups">
                  {groups.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
        )}

        <div className="field span2">
          <span>Photos in lists</span>
          <Segmented
            label="Photos in lists"
            value={photos}
            onChange={(v) => {
              setPhotos(v);
              onDirty();
            }}
            options={[
              { value: "app", label: `As in Settings (${imageModeLabel(appImageMode())})` },
              ...IMAGE_MODES.map((m) => ({ value: m.id as ImageMode | "app", label: m.label })),
            ]}
          />
          <small className="field-hint">{photos === "app" ? "Follows Settings → Browsing → Photos." : IMAGE_MODES.find((m) => m.id === photos)?.hint}</small>
        </div>
        {photos !== "off" && (photos !== "app" || appImageMode() !== "off") && (
          <label className="check span2">
            <input
              type="checkbox"
              checked={sharing}
              onChange={(e) => {
                setSharing(e.target.checked);
                onDirty();
              }}
            />
            <span>
              Share placeholders with other devices
              <em>{SHARE_PLACEHOLDERS_TEXT}</em>
            </span>
          </label>
        )}

        <p className="hint span2">
          <Icon name="check-circle" size={13} />
          {SECRET_NOTE}
        </p>

        {result && (
          <div ref={resultRef} className={`result span2 ${result.ok ? "ok" : "bad"}`} role={result.ok ? "status" : "alert"}>
            <Icon name={result.ok ? "check-circle" : "alert"} size={15} />
            <div>
              <ErrorText message={result.text} />
              {cert && result.draft && (
                <div className="cert-actions">
                  <TrustCertButton cert={cert} host={cert.host || hostOf(result.draft.profile)} onTrust={trustCert} />
                </div>
              )}
            </div>
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
