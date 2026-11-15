import { useEffect, useRef, useState } from "react";
import { ErrorText } from "./ErrorText";
import { api, errMessage } from "../api";
import { Icon } from "../Icons";
import { providerMeta } from "../providers";
import { Modal } from "./Dialogs";
import { ProviderBadge } from "./Sidebar";
import type { Profile } from "../types";

/** Keys, endpoints and bucket names are typed exactly: no autocorrect or capitals on phones. */
const ANDROID = /Android/i.test(navigator.userAgent);

const RAW = {
  spellCheck: false,
  autoCorrect: "off",
  autoCapitalize: "off",
  autoComplete: "off",
} as const;

type Preset = {
  id: string;
  label: string;
  regions?: { value: string; label: string }[];
  endpoint: (region: string) => string;
  defaultRegion: string;
  pathStyle: boolean;
  hint?: string;
};

const PRESETS: Preset[] = [
  {
    id: "hetzner",
    label: "Hetzner Object Storage",
    regions: [
      { value: "nbg1", label: "Nuremberg (nbg1)" },
      { value: "fsn1", label: "Falkenstein (fsn1)" },
      { value: "hel1", label: "Helsinki (hel1)" },
    ],
    endpoint: (r) => `https://${r}.your-objectstorage.com`,
    defaultRegion: "nbg1",
    pathStyle: false,
    hint: "Hetzner keys cannot list all buckets, so enter your bucket name in the Bucket field.",
  },
  {
    id: "aws",
    label: "Amazon S3",
    endpoint: (r) => `https://s3.${r}.amazonaws.com`,
    defaultRegion: "eu-central-1",
    pathStyle: false,
  },
  {
    id: "r2",
    label: "Cloudflare R2",
    endpoint: () => "https://<account-id>.r2.cloudflarestorage.com",
    defaultRegion: "auto",
    pathStyle: false,
    hint: "Replace <account-id> in the endpoint with your Cloudflare account id.",
  },
  {
    id: "b2",
    label: "Backblaze B2",
    endpoint: (r) => `https://s3.${r}.backblazeb2.com`,
    defaultRegion: "eu-central-003",
    pathStyle: false,
  },
  {
    id: "wasabi",
    label: "Wasabi",
    endpoint: (r) => `https://s3.${r}.wasabisys.com`,
    defaultRegion: "eu-central-1",
    pathStyle: false,
  },
  {
    id: "do",
    label: "DigitalOcean Spaces",
    endpoint: (r) => `https://${r}.digitaloceanspaces.com`,
    defaultRegion: "fra1",
    pathStyle: false,
  },
  {
    id: "custom",
    label: "Other S3-compatible (MinIO, Ceph, …)",
    endpoint: () => "",
    defaultRegion: "us-east-1",
    pathStyle: true,
  },
];

export function ConnectionDialog({
  initial,
  onSaved,
  onDeleted,
  onClose,
  onKybl,
  kyblFirst,
}: {
  initial: Profile | null;
  /** switch to "Connect Kybl Storage" (no keys to type) */
  onKybl?: () => void;
  /**
   * No Kybl Storage connection yet: open on the short choice (Kybl, or another provider) and keep
   * the provider grid and key fields folded away until asked for.
   */
  kyblFirst?: boolean;
  onSaved: (p: Profile) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const startPreset = PRESETS.find((p) => p.id === initial?.provider) ?? PRESETS[0];
  const [provider, setProvider] = useState(startPreset.id);
  const [name, setName] = useState(initial?.name ?? "");
  const [region, setRegion] = useState(initial?.region ?? startPreset.defaultRegion);
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? startPreset.endpoint(startPreset.defaultRegion));
  const [accessKeyId, setAccessKeyId] = useState(initial?.accessKeyId ?? "");
  const [secret, setSecret] = useState("");
  const [bucket, setBucket] = useState(initial?.bucket ?? "");
  const [pathStyle, setPathStyle] = useState(initial?.pathStyle ?? startPreset.pathStyle);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);
  // On small screens the result lands below the fold; bring it into view.
  useEffect(() => {
    if (result)
      resultRef.current?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
  }, [result]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const choosing = !initial && !!onKybl && !!kyblFirst;
  /** the provider grid and key fields are showing (always, unless `choosing`) */
  const [custom, setCustom] = useState(!choosing);

  const preset = PRESETS.find((p) => p.id === provider) ?? PRESETS[0];

  const pickProvider = (id: string) => {
    const p = PRESETS.find((x) => x.id === id) ?? PRESETS[0];
    setProvider(id);
    setRegion(p.defaultRegion);
    setEndpoint(p.endpoint(p.defaultRegion));
    setPathStyle(p.pathStyle);
    setResult(null);
  };

  const pickRegion = (r: string) => {
    setRegion(r);
    setEndpoint(preset.endpoint(r));
  };

  const build = (): Profile => ({
    id: initial?.id ?? "",
    name: name.trim() || `${preset.label}${bucket ? ` · ${bucket}` : ""}`,
    provider,
    endpoint: endpoint.trim(),
    region: region.trim(),
    accessKeyId: accessKeyId.trim(),
    bucket: bucket.trim() || null,
    pathStyle,
  });

  const valid = accessKeyId.trim() && (secret || initial) && (endpoint.trim() || provider === "aws");

  const test = async () => {
    setBusy("test");
    setResult(null);
    try {
      const text = await api.testConnection(build(), secret || undefined);
      setResult({ ok: true, text });
    } catch (e) {
      setResult({ ok: false, text: errMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    try {
      const saved = await api.saveProfile(build(), secret || undefined);
      onSaved(saved);
      onClose();
    } catch (e) {
      setResult({ ok: false, text: errMessage(e) });
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!initial) return;
    await api.deleteProfile(initial.id);
    onDeleted(initial.id);
    onClose();
  };

  return (
    <Modal title={initial ? "Edit connection" : "New connection"} onClose={onClose} width={custom ? 540 : 420}>
      {!custom ? (
        <div className="modal-body conn-choose">
          <div className="conn-choose-kybl">
            <ProviderBadge provider="kybl" large />
            <strong>Kybl Storage</strong>
            <p>Sign in with your browser and your buckets show up. No keys to copy.</p>
          </div>
          <button type="button" className="btn btn-primary conn-choose-main" onClick={onKybl}>
            <Icon name="cloud" size={15} /> Connect with Kybl Storage
          </button>
          <div className="conn-choose-or" aria-hidden="true">
            <span>or</span>
          </div>
          <button type="button" className="btn btn-ghost conn-choose-other" onClick={() => setCustom(true)}>
            <span className="conn-choose-badges" aria-hidden="true">
              {PRESETS.slice(0, 4).map((p) => (
                <ProviderBadge key={p.id} provider={p.id} />
              ))}
            </span>
            Use another provider with keys
            <Icon name="chevron-down" size={14} />
          </button>
        </div>
      ) : (
        <div className="modal-body form-grid">
          {choosing && (
            <button type="button" className="kybl-offer span2" onClick={onKybl}>
              <ProviderBadge provider="kybl" large />
              <span className="kybl-offer-text">
                <strong>Kybl Storage</strong>
                <em>Sign in with your browser. No keys to copy.</em>
              </span>
              <Icon name="chevron" size={14} />
            </button>
          )}
          <div className="field span2">
            <span>Provider</span>
            <div className="provider-grid" role="radiogroup" aria-label="Provider">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={provider === p.id}
                  className={`provider-tile ${provider === p.id ? "on" : ""}`}
                  title={p.label}
                  onClick={() => pickProvider(p.id)}
                >
                  <ProviderBadge provider={p.id} large />
                  {providerMeta(p.id).short}
                </button>
              ))}
            </div>
          </div>

          <label className="field span2">
            <span>
              Name <em>optional</em>
            </span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={preset.label} />
          </label>

          {preset.regions ? (
            <label className="field">
              <span>Region</span>
              <select value={region} onChange={(e) => pickRegion(e.target.value)}>
                {preset.regions.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="field">
              <span>Region</span>
              <input value={region} onChange={(e) => pickRegion(e.target.value)} {...RAW} />
            </label>
          )}

          <label className="field">
            <span>
              Bucket <em>optional</em>
            </span>
            <input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="my-bucket" {...RAW} />
          </label>

          <label className="field span2">
            <span>Endpoint</span>
            <input className="mono" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://…" inputMode="url" {...RAW} />
          </label>

          <label className="field">
            <span>Access key ID</span>
            <input className="mono" value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} {...RAW} />
          </label>
          <label className="field">
            <span>Secret access key</span>
            <div className="input-wrap">
              <input
                className="mono"
                type={showSecret ? "text" : "password"}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={initial ? (ANDROID ? "Saved on this device" : "Saved in keychain") : ""}
                {...RAW}
              />
              <button
                type="button"
                className="icon-btn"
                onClick={() => setShowSecret((v) => !v)}
                title={showSecret ? "Hide secret" : "Show secret"}
                aria-label={showSecret ? "Hide secret" : "Show secret"}
              >
                <Icon name={showSecret ? "eye-off" : "eye"} size={14} />
              </button>
            </div>
          </label>

          <label className="check span2">
            <input type="checkbox" checked={pathStyle} onChange={(e) => setPathStyle(e.target.checked)} />
            <span>
              Use path-style addressing
              <em>Needed by MinIO and many self-hosted servers.</em>
            </span>
          </label>

          {preset.hint && (
            <p className="hint span2">
              <Icon name="info" size={13} />
              {preset.hint}
            </p>
          )}

          <p className="hint span2">
            <Icon name="check-circle" size={13} />
            {ANDROID
              ? "The secret key stays on this device, in Kybl's private storage, and is left out of backups."
              : "The secret key is stored in your system keychain, never in a file."}
          </p>

          {result && (
            <div ref={resultRef} className={`result span2 ${result.ok ? "ok" : "bad"}`}>
              <Icon name={result.ok ? "check-circle" : "alert"} size={15} />
              <ErrorText message={result.text} />
            </div>
          )}
        </div>
      )}
      {custom && (
        <div className="modal-foot split">
          <div className="btn-row">
            {initial &&
              (confirmDelete ? (
                <>
                  <button className="btn btn-danger" onClick={remove}>
                    Delete connection
                  </button>
                  <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
                    Keep
                  </button>
                </>
              ) : (
                <button className="btn btn-danger-ghost" onClick={() => setConfirmDelete(true)}>
                  <Icon name="trash" size={14} /> Delete
                </button>
              ))}
          </div>
          <div className="btn-row">
            <button className="btn" onClick={test} disabled={!valid || busy !== null}>
              {busy === "test" && <span className="spinner" />}
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
            <button className="btn btn-primary" onClick={save} disabled={!valid || busy !== null}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
