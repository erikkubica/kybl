/** Azure Blob Storage (one container) and Google Cloud Storage (one bucket). */
import { useImperativeHandle, useRef, useState } from "react";
import { Icon } from "../Icons";
import type { BlobConfig, Profile } from "../types";
import { baseProfile, blobTarget, emptyBlob, type BlobKind } from "./kinds";
import { Field, RAW, SecretInput, type FormApi } from "./fields";

export function BlobForm({ kind, initial, tried, formApi, onEdit }: { kind: BlobKind; initial: Profile | null; tried: boolean; formApi: React.Ref<FormApi>; onEdit: () => void }) {
  const start = initial?.blob ?? emptyBlob();
  const [name, setName] = useState(initial?.name ?? "");
  const [account, setAccount] = useState(start.account);
  const [container, setContainer] = useState(start.container ?? "");
  const [endpoint, setEndpoint] = useState(start.endpoint);
  const [secret, setSecret] = useState("");
  const [fileNote, setFileNote] = useState<string | null>(null);
  const jsonFile = useRef<HTMLInputElement>(null);
  const azure = kind === "azblob";
  // the saved key (a SAS token or service account key is the credential itself) belongs to the
  // endpoint and account it was saved for: a new one needs its own, never sent on to a new server
  const editing = !!initial && blobTarget(kind, start) === blobTarget(kind, { account: azure ? account : "", endpoint, container });

  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      onEdit();
    };

  const ep = endpoint.trim();
  const problems = {
    account: azure && !account.trim() ? "Enter the storage account name." : null,
    container: container.trim() ? null : azure ? "Enter the container's name." : "Enter the bucket's name.",
    endpoint: ep && !/^https?:\/\/[^\s/]+/i.test(ep) ? "Start with https:// (or http:// for a local emulator)." : null,
    secret:
      !secret.trim() && !editing
        ? azure
          ? initial
            ? "Enter the key again for the new account or endpoint."
            : "Enter the account key or a SAS token."
          : initial
            ? "Paste the service account key again for the new endpoint."
            : "Paste the service account key or choose its file."
        : !azure && secret.trim() && !/"private_key"/.test(secret)
          ? "This doesn't look like a service account key. It's a JSON file with a “private_key” in it."
          : null,
  };
  const show = (k: keyof typeof problems) => (tried ? problems[k] : null);

  useImperativeHandle(formApi, () => ({
    draft: () => {
      if (Object.values(problems).some(Boolean)) return null;
      const blob: BlobConfig = { account: azure ? account.trim() : "", endpoint: ep, container: container.trim() };
      const title = azure ? `${account.trim()} · ${container.trim()}` : container.trim();
      return { profile: { ...baseProfile(initial?.id ?? "", name.trim() || title, kind), blob }, secret: secret.trim() || undefined };
    },
  }));

  const readJson = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 256 * 1024) {
      setFileNote("That file is too big to be a service account key.");
      return;
    }
    const text = await f.text();
    setSecret(text.trim());
    setFileNote(/"private_key"/.test(text) ? `Loaded ${f.name}` : `${f.name} doesn't look like a service account key.`);
    onEdit();
  };

  return (
    <>
      <Field label="Name" optional wide>
        {(c) => <input {...c} value={name} onChange={(e) => edit(setName)(e.target.value)} placeholder={azure ? "My Azure container" : "My GCS bucket"} />}
      </Field>
      {azure && (
        <Field label="Storage account" error={show("account")}>
          {(c) => <input {...c} className="mono" value={account} onChange={(e) => edit(setAccount)(e.target.value)} placeholder="mystorageaccount" {...RAW} />}
        </Field>
      )}
      <Field label={azure ? "Container" : "Bucket"} error={show("container")} wide={!azure}>
        {(c) => <input {...c} className="mono" value={container} onChange={(e) => edit(setContainer)(e.target.value)} placeholder={azure ? "photos" : "my-bucket"} {...RAW} />}
      </Field>

      {azure ? (
        <Field label="Account key or SAS token" wide error={show("secret")} hint="From the storage account's Access keys page, or a SAS token starting with “?”.">
          {(c) => <SecretInput control={c} value={secret} onChange={edit(setSecret)} editing={editing} label="key" />}
        </Field>
      ) : (
        <Field label="Service account key" wide error={show("secret")} hint={fileNote ?? "The JSON key file from Google Cloud: IAM › Service accounts › Keys."}>
          {(c) => (
            <div className="conn-key">
              <textarea
                {...c}
                className="mono conn-key-text"
                value={secret}
                onChange={(e) => {
                  setFileNote(null);
                  edit(setSecret)(e.target.value);
                }}
                placeholder={editing ? "Unchanged. Paste a new key to replace it." : '{ "type": "service_account", … }'}
                rows={3}
                {...RAW}
              />
              <button type="button" className="btn btn-sm" onClick={() => jsonFile.current?.click()}>
                <Icon name="file" size={13} /> Choose file…
              </button>
              <input
                ref={jsonFile}
                type="file"
                accept=".json,application/json"
                hidden
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  void readJson(e.currentTarget.files?.[0]);
                  e.currentTarget.value = "";
                }}
              />
            </div>
          )}
        </Field>
      )}

      <Field label="Endpoint" optional wide error={show("endpoint")} hint={azure ? "Only for Azurite or a national cloud." : "Only for an emulator or a compatible service."}>
        {(c) => <input {...c} className="mono" value={endpoint} onChange={(e) => edit(setEndpoint)(e.target.value)} placeholder={azure ? "https://mystorageaccount.blob.core.windows.net" : "https://storage.googleapis.com"} inputMode="url" {...RAW} />}
      </Field>
    </>
  );
}
