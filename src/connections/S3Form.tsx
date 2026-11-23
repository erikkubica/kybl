/** S3-compatible storage: a provider preset, an endpoint, and an access key pair. */
import { useImperativeHandle, useState } from "react";
import { Icon } from "../Icons";
import { providerMeta } from "../providers";
import { ProviderBadge } from "../components/Sidebar";
import type { Profile } from "../types";
import { Field, RAW, SecretInput, type FormApi } from "./fields";
import { endpointAfterRegion } from "./s3Endpoint";

type Preset = {
  id: string;
  label: string;
  regions?: { value: string; label: string }[];
  endpoint: (region: string) => string;
  defaultRegion: string;
  pathStyle: boolean;
  hint?: string;
};

export const PRESETS: Preset[] = [
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

export function S3Form({ initial, tried, formApi, onEdit }: { initial: Profile | null; tried: boolean; formApi: React.Ref<FormApi>; onEdit: () => void }) {
  const startPreset = PRESETS.find((p) => p.id === initial?.provider) ?? PRESETS[0];
  const [provider, setProvider] = useState(startPreset.id);
  const [name, setName] = useState(initial?.name ?? "");
  const [region, setRegion] = useState(initial?.region ?? startPreset.defaultRegion);
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? startPreset.endpoint(startPreset.defaultRegion));
  const [accessKeyId, setAccessKeyId] = useState(initial?.accessKeyId ?? "");
  const [secret, setSecret] = useState("");
  const [bucket, setBucket] = useState(initial?.bucket ?? "");
  const [pathStyle, setPathStyle] = useState(initial?.pathStyle ?? startPreset.pathStyle);
  const preset = PRESETS.find((p) => p.id === provider) ?? PRESETS[0];

  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      onEdit();
    };

  const pickProvider = (id: string) => {
    const p = PRESETS.find((x) => x.id === id) ?? PRESETS[0];
    setProvider(id);
    setRegion(p.defaultRegion);
    setEndpoint(p.endpoint(p.defaultRegion));
    setPathStyle(p.pathStyle);
    onEdit();
  };
  const pickRegion = (r: string) => {
    setRegion(r);
    setEndpoint(endpointAfterRegion(preset.endpoint, region, r, endpoint));
    onEdit();
  };

  const ep = endpoint.trim();
  const problems = {
    endpoint:
      !ep && provider !== "aws"
        ? "Enter the endpoint address from your provider."
        : ep.includes("<account-id>")
          ? "Replace <account-id> with your Cloudflare account id."
          : ep && !/^https?:\/\/[^\s/]+/i.test(ep)
            ? "Start with https:// (or http:// for a local server)."
            : null,
    accessKeyId: accessKeyId.trim() ? null : "Enter the access key ID.",
    secret: secret || initial ? null : "Enter the secret access key.",
  };
  const show = (k: keyof typeof problems) => (tried ? problems[k] : null);

  useImperativeHandle(formApi, () => ({
    draft: () => {
      if (Object.values(problems).some(Boolean)) return null;
      const profile: Profile = {
        id: initial?.id ?? "",
        name: name.trim() || `${preset.label}${bucket ? ` · ${bucket}` : ""}`,
        kind: "s3",
        provider,
        endpoint: ep,
        region: region.trim(),
        accessKeyId: accessKeyId.trim(),
        bucket: bucket.trim() || null,
        pathStyle,
      };
      // S3 secrets never hold whitespace: a pasted trailing space or newline would only break the signature
      return { profile, secret: secret.trim() || undefined };
    },
  }));

  return (
    <>
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

      <Field label="Name" optional wide>
        {(c) => <input {...c} value={name} onChange={(e) => edit(setName)(e.target.value)} placeholder={preset.label} />}
      </Field>

      <Field label="Region">
        {(c) =>
          preset.regions ? (
            <select {...c} value={region} onChange={(e) => pickRegion(e.target.value)}>
              {preset.regions.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          ) : (
            <input {...c} value={region} onChange={(e) => pickRegion(e.target.value)} {...RAW} />
          )
        }
      </Field>

      <Field label="Bucket" optional>
        {(c) => <input {...c} value={bucket} onChange={(e) => edit(setBucket)(e.target.value)} placeholder="my-bucket" {...RAW} />}
      </Field>

      <Field label="Endpoint" wide error={show("endpoint")}>
        {(c) => <input {...c} className="mono" value={endpoint} onChange={(e) => edit(setEndpoint)(e.target.value)} placeholder="https://…" inputMode="url" {...RAW} />}
      </Field>

      <Field label="Access key ID" error={show("accessKeyId")}>
        {(c) => <input {...c} className="mono" value={accessKeyId} onChange={(e) => edit(setAccessKeyId)(e.target.value)} {...RAW} />}
      </Field>
      <Field label="Secret access key" error={show("secret")}>
        {(c) => <SecretInput control={c} value={secret} onChange={edit(setSecret)} editing={!!initial} />}
      </Field>

      <label className="check span2">
        <input type="checkbox" checked={pathStyle} onChange={(e) => edit(setPathStyle)(e.target.checked)} />
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
    </>
  );
}
