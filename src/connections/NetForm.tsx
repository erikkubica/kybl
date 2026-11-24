/** Servers: WebDAV (Nextcloud and friends), FTP / FTPS and SFTP. */
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../Icons";
import type { NetConfig, Profile } from "../types";
import { baseProfile, defaultPort, emptyNet, netTitle, passwordTarget, type NetKind } from "./kinds";
import { Field, PHONE, RAW, SecretInput, Segmented, Warning, type FormApi } from "./fields";
import { splitServer } from "./serverHost";
import { TunnelsSection, tidyTunnels, tunnelProblem } from "../tunnels/TunnelsSection";

/** A WebDAV address from a profile saved with host and port instead of a URL. */
function davUrl(n: NetConfig): string {
  if (n.url) return n.url;
  if (!n.host) return "";
  const scheme = n.tls === "none" ? "http" : "https";
  return `${scheme}://${n.host}${n.port ? `:${n.port}` : ""}/`;
}

const looksLikeKey = (t: string) => /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|PuTTY-User-Key-File-/.test(t);

export function NetForm({
  kind,
  initial,
  tried,
  formApi,
  onEdit,
}: {
  kind: NetKind;
  initial: Profile | null;
  tried: boolean;
  formApi: React.Ref<FormApi>;
  onEdit: () => void;
}) {
  const start = initial?.net ?? emptyNet(kind);
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(kind === "webdav" ? davUrl(start) : "");
  const [host, setHost] = useState(start.host);
  const [port, setPort] = useState(start.port ? String(start.port) : "");
  const [user, setUser] = useState(start.user);
  const [basePath, setBasePath] = useState(start.basePath);
  const [tls, setTls] = useState<NetConfig["tls"]>(start.tls);
  // ssh-agent only exists on computers; a profile saved with it on a phone falls back to a key
  const [auth, setAuth] = useState<NetConfig["auth"]>(PHONE && start.auth === "agent" ? "key" : start.auth);
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [hostKey, setHostKeyState] = useState<string | null>(start.hostKey ?? null);
  // read by draft() right after the dialog trusts a key, before the state update has rendered
  const hostKeyRef = useRef(hostKey);
  // FTPS / WebDAV: the server's own certificate, once trusted (same timing as the host key)
  const [certFp, setCertFpState] = useState<string | null>(start.certFingerprint ?? null);
  const certFpRef = useRef(certFp);
  const keyFile = useRef<HTMLInputElement>(null);
  const [keyNote, setKeyNote] = useState<string | null>(null);
  // SFTP: SSH tunnels through the server (src/tunnels)
  const [tunnels, setTunnels] = useState(start.tunnels ?? []);
  const editing = !!initial;
  // ask the vault whether a password or key is saved (null: not known yet). FTP / WebDAV: a
  // password is optional; SFTP: an imported connection may have none yet
  const [hasSecret, setHasSecret] = useState<boolean | null>(null);
  const [clearSecret, setClearSecret] = useState(false);
  useEffect(() => {
    if (!initial || (kind === "sftp" && initial.net?.auth === "agent")) return;
    let live = true;
    api
      .profileHasSecret(initial.id)
      .then((v) => live && setHasSecret(v))
      .catch(() => live && setHasSecret(true));
    return () => {
      live = false;
    };
  }, [initial, kind]);
  // SFTP: "Unchanged" only for what was saved with the same sign-in, and is in the vault
  const sftpSaved = (a: NetConfig["auth"]) => editing && initial?.net?.auth === a && hasSecret !== false;

  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      onEdit();
    };
  const setHostKey = (fp: string | null) => {
    hostKeyRef.current = fp;
    setHostKeyState(fp);
  };
  const setCertFingerprint = (fp: string | null) => {
    certFpRef.current = fp;
    setCertFpState(fp);
  };
  // a trusted key belongs to one server: another address or port must be checked anew (back to
  // the saved address, the saved key holds again)
  const placeChanged = (h: string, p: string) => {
    // an empty port is the usual one (22 for SFTP)
    const portOf = (n: number) => n || defaultPort(kind, tls);
    const same = h.trim().toLowerCase() === start.host.trim().toLowerCase() && portOf(Number(p.trim()) || 0) === portOf(start.port || 0);
    setHostKey(same ? (start.hostKey ?? null) : null);
    setCertFingerprint(same ? (start.certFingerprint ?? null) : null);
  };
  /** WebDAV: the same for its address (another server, another certificate) */
  const urlChanged = (u: string) => {
    const hostOf = (s: string) => {
      try {
        return new URL(s.trim().replace(/^(web)?davs?:/i, "https:")).host.toLowerCase();
      } catch {
        return s.trim().toLowerCase();
      }
    };
    setCertFingerprint(hostOf(u) === hostOf(davUrl(start)) ? (start.certFingerprint ?? null) : null);
  };

  // the saved key stays unless a new one is pasted; a connection that had none needs one now
  const hadKey = sftpSaved("key");
  // a pasted sftp://me@host:2222 fills Port and User name (on leaving the field, and on Save)
  const server = splitServer(host);
  const parts = typeof server === "string" ? null : server;
  // a port pasted into Server wins over the one in the field, as it does once the field is left:
  // Enter submits without leaving it
  const portNum = parts?.port ? parts.port : port.trim() ? Number(port.trim()) : 0;
  const tidyServer = () => {
    if (!parts || (parts.host === host.trim() && !parts.port && !parts.user)) return;
    const p = parts.port ? String(parts.port) : port;
    setHost(parts.host);
    setPort(p);
    if (parts.user && !user.trim()) setUser(parts.user);
    placeChanged(parts.host, p);
    onEdit();
  };
  const davHref = url.trim();
  const davInsecure = kind === "webdav" && /^(http|dav|webdav):\/\//i.test(davHref);
  // a saved password only goes to the server and user name it was saved for: another one asks
  // for it again (the app refuses it too). Name, folder and other changes keep it.
  const nowNet: NetConfig = {
    ...start,
    host: host.trim(),
    port: Number.isInteger(portNum) ? portNum : 0,
    user,
    tls: kind === "webdav" ? (davInsecure ? "none" : "implicit") : tls,
    auth: kind === "sftp" ? auth : "password",
    url: kind === "webdav" ? davHref : null,
  };
  const target = passwordTarget(kind, nowNet);
  const moved = editing && target !== null && target !== passwordTarget(kind, start);
  const savedPassword = kind === "sftp" ? sftpSaved("password") && !moved : !!hasSecret && !clearSecret && !moved;

  const problems = {
    url: kind !== "webdav" ? null : !davHref ? "Enter the server's address." : !/^(https?|(web)?davs?):\/\/[^\s/]+/i.test(davHref) ? "Start with https:// (for example https://cloud.example.com)." : null,
    host: kind === "webdav" ? null : typeof server === "string" ? server : null,
    port: kind === "webdav" || !port.trim() ? null : Number.isInteger(portNum) && portNum > 0 && portNum < 65536 ? null : "Ports are numbers from 1 to 65535.",
    user: kind === "sftp" && !user.trim() && !parts?.user ? "Enter your user name on the server." : null,
    password:
      password || clearSecret
        ? null
        : kind === "sftp"
          ? auth === "password" && !savedPassword
            ? moved
              ? "The server or user name changed. Enter the password again."
              : "Enter the password."
            : null
          : moved && hasSecret
            ? "The server or user name changed. Enter the password again, or remove the saved one."
            : null,
    privateKey:
      kind !== "sftp" || auth !== "key"
        ? null
        : !privateKey.trim()
          ? hadKey
            ? null
            : "Paste your private key or choose its file."
          : looksLikeKey(privateKey)
            ? null
            : "This doesn't look like a private key. It starts with “-----BEGIN”.",
    tunnels: kind === "sftp" ? tunnelProblem(tunnels) : null,
  };
  const show = (k: keyof typeof problems) => (tried ? problems[k] : null);

  useImperativeHandle(formApi, () => ({
    draft: () => {
      if (Object.values(problems).some(Boolean)) return null;
      const net: NetConfig = {
        host: kind === "webdav" ? "" : (parts?.host ?? host.trim()),
        port: kind === "webdav" ? 0 : portNum,
        user: user.trim() || (kind === "webdav" ? "" : (parts?.user ?? "")),
        basePath: basePath.trim(),
        tls: kind === "webdav" ? (davInsecure ? "none" : "implicit") : kind === "sftp" ? "none" : tls,
        auth: kind === "sftp" ? auth : "password",
        hostKey: kind === "sftp" ? hostKeyRef.current : null,
        certFingerprint: kind === "sftp" ? null : certFpRef.current,
        url: kind === "webdav" ? davHref : null,
        tunnels: kind === "sftp" ? tidyTunnels(tunnels) : [],
      };
      const profile: Profile = { ...baseProfile(initial?.id ?? "", name.trim() || netTitle(kind, net), kind), net };
      let secret: string | undefined;
      if (kind === "sftp" && auth === "key") {
        const k = privateKey.trim();
        // a passphrase alone goes with the saved key (the backend joins them)
        secret = k ? (passphrase ? JSON.stringify({ privateKey: k, passphrase }) : k) : passphrase ? JSON.stringify({ passphrase }) : undefined;
      } else if (!(kind === "sftp" && auth === "agent")) secret = password || undefined;
      return { profile, secret, clearSecret: kind !== "sftp" && clearSecret && !password };
    },
    setHostKey,
    setCertFingerprint,
  }));

  const readKeyFile = async (f: File | undefined) => {
    if (!f) return;
    // private keys are a few KB; anything big is the wrong file
    if (f.size > 64 * 1024) {
      setKeyNote("That file is too big to be a private key.");
      return;
    }
    const text = await f.text();
    setPrivateKey(text.trim());
    setKeyNote(looksLikeKey(text) ? `Loaded ${f.name}` : `${f.name} doesn't look like a private key.`);
    onEdit();
  };

  const placeholderHost = kind === "sftp" ? "server.example.com" : "ftp.example.com";

  return (
    <>
      <Field label="Name" optional wide>
        {(c) => <input {...c} value={name} onChange={(e) => edit(setName)(e.target.value)} placeholder={kind === "webdav" ? "My Nextcloud" : "My server"} />}
      </Field>

      {kind === "webdav" ? (
        <Field
          label="Server address"
          wide
          error={show("url")}
          hint="Nextcloud and ownCloud: the server's address is enough. Synology: include the WebDAV port, such as https://nas.local:5006."
        >
          {(c) => <input {...c} className="mono" value={url} onChange={(e) => {
                edit(setUrl)(e.target.value);
                urlChanged(e.target.value);
              }} placeholder="https://cloud.example.com" inputMode="url" {...RAW} />}
        </Field>
      ) : (
        <>
          <Field label="Server" error={show("host")}>
            {(c) => <input {...c} className="mono" value={host} onChange={(e) => {
                  edit(setHost)(e.target.value);
                  placeChanged(e.target.value, port);
                }} onBlur={tidyServer} placeholder={placeholderHost} inputMode="url" {...RAW} />}
          </Field>
          <Field label="Port" optional error={show("port")}>
            {(c) => (
              <input {...c} className="mono" value={port} onChange={(e) => {
                const p = e.target.value.replace(/[^\d]/g, "");
                edit(setPort)(p);
                placeChanged(host, p);
              }} placeholder={String(defaultPort(kind, tls))} inputMode="numeric" {...RAW} />
            )}
          </Field>
        </>
      )}

      {kind === "ftp" && (
        <div className="field span2">
          <span>Encryption</span>
          <Segmented
            label="Encryption"
            value={tls === "auto" ? "explicit" : tls}
            // switching between kinds of FTPS keeps the fallback choice only where it applies
            onChange={(v) => edit(setTls)(v === "explicit" && tls === "auto" ? "auto" : v)}
            options={[
              { value: "explicit", label: "FTPS" },
              { value: "implicit", label: "FTPS, implicit" },
              { value: "none", label: "None" },
            ]}
          />
          <small className="field-hint">
            {tls === "explicit" || tls === "auto"
              ? "The usual secure FTP (also called FTPES), on port 21."
              : tls === "implicit"
                ? "Older secure FTP, encrypted from the first byte, usually on port 990."
                : "Plain FTP, for servers that offer nothing else."}
          </small>
        </div>
      )}
      {kind === "ftp" && (tls === "explicit" || tls === "auto") && (
        <label className="check span2">
          <input type="checkbox" checked={tls === "auto"} onChange={(e) => edit(setTls)(e.target.checked ? "auto" : "explicit")} />
          <span>
            Fall back to plain FTP if the server doesn't support encryption
            <em>Like FileZilla’s “TLS if available”, except that Kybl asks you once before it first sends your password unencrypted. Once the server has encrypted a connection (or when it says it can), Kybl no longer falls back. Still, leave this off once you know the server supports FTPS.</em>
          </span>
        </label>
      )}
      {kind === "ftp" && tls === "none" && <Warning>Plain FTP isn't encrypted. Your password and every file cross the network where others could read them. Use it only on networks you trust.</Warning>}
      {davInsecure && <Warning>This address starts with http://, so your password and files travel unencrypted. Use https:// if the server supports it.</Warning>}

      <Field label="User name" optional={kind !== "sftp"} error={show("user")} hint={kind === "ftp" ? "Leave empty to sign in as anonymous." : undefined}>
        {(c) => <input {...c} value={user} onChange={(e) => edit(setUser)(e.target.value)} {...RAW} autoComplete="username" />}
      </Field>

      {kind === "sftp" && (
        <div className="field">
          <span>Sign in with</span>
          <Segmented
            label="Sign in with"
            value={auth}
            onChange={edit(setAuth)}
            options={[
              { value: "password", label: "Password" },
              { value: "key", label: "Key" },
              ...(PHONE ? [] : [{ value: "agent" as const, label: "SSH agent" }]),
            ]}
          />
        </div>
      )}

      {(kind !== "sftp" || auth === "password") && (
        <Field
          label="Password"
          optional={kind !== "sftp"}
          error={show("password")}
          hint={
            kind !== "sftp" && hasSecret && !password ? (
              clearSecret ? (
                <>
                  Signs in without a password once saved.{" "}
                  <button type="button" className="link-btn" onClick={() => edit(setClearSecret)(false)}>
                    Keep it
                  </button>
                </>
              ) : (
                <button type="button" className="link-btn" onClick={() => edit(setClearSecret)(true)}>
                  Remove saved password
                </button>
              )
            ) : kind === "webdav" ? (
              "Using two-step sign-in? Create an app password in your account's security settings and use it here."
            ) : undefined
          }
        >
          {(c) => <SecretInput control={c} value={password} onChange={edit(setPassword)} editing={savedPassword} label="password" />}
        </Field>
      )}

      {kind === "sftp" && auth === "key" && (
        <>
          <Field label="Private key" wide error={show("privateKey")} hint={keyNote ?? "OpenSSH, PEM or PuTTY (.ppk) keys: Ed25519, ECDSA or RSA."}>
            {(c) => (
              <div className="conn-key">
                <textarea
                  {...c}
                  className="mono conn-key-text"
                  value={privateKey}
                  onChange={(e) => {
                    setKeyNote(null);
                    edit(setPrivateKey)(e.target.value);
                  }}
                  placeholder={hadKey ? "Unchanged. Paste a new key to replace it." : "-----BEGIN OPENSSH PRIVATE KEY-----"}
                  rows={3}
                  {...RAW}
                />
                <button type="button" className="btn btn-sm" onClick={() => keyFile.current?.click()}>
                  <Icon name="file" size={13} /> Choose file…
                </button>
                <input
                  ref={keyFile}
                  type="file"
                  hidden
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => {
                    void readKeyFile(e.currentTarget.files?.[0]);
                    e.currentTarget.value = "";
                  }}
                />
              </div>
            )}
          </Field>
          <Field label="Key passphrase" optional>
            {(c) => <SecretInput control={c} value={passphrase} onChange={edit(setPassphrase)} editing={false} placeholder={hadKey ? "Unchanged" : ""} label="passphrase" />}
          </Field>
        </>
      )}
      {kind === "sftp" && auth === "agent" && (
        <p className="hint span2">
          <Icon name="info" size={13} />
          Kybl asks the SSH agent already running on this computer (ssh-agent, 1Password, Pageant…) for your key.
        </p>
      )}

      <Field
        label="Start in folder"
        optional
        wide={kind !== "sftp" || auth !== "key"}
        hint={kind === "webdav" ? undefined : kind === "sftp" ? "Empty: your home folder." : "Empty: the folder you land in after signing in."}
      >
        {(c) => <input {...c} className="mono" value={basePath} onChange={(e) => edit(setBasePath)(e.target.value)} placeholder={kind === "sftp" ? "/var/www" : "/"} {...RAW} />}
      </Field>

      {kind === "sftp" && hostKey && (
        <div className="conn-fp span2">
          <Icon name="check-circle" size={14} />
          <span>
            Trusted server key
            <code className="selectable">{hostKey}</code>
          </span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setHostKey(null);
              onEdit();
            }}
          >
            Forget
          </button>
        </div>
      )}
      {kind === "sftp" && !PHONE && <TunnelsSection profileId={initial?.id ?? ""} tunnels={tunnels} tried={tried} onChange={edit(setTunnels)} />}
      {kind !== "sftp" && certFp && (
        <div className="conn-fp span2">
          <Icon name="check-circle" size={14} />
          <span>
            Trusted server certificate
            <code className="selectable" title={certFp}>
              {certFp}
            </code>
          </span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setCertFingerprint(null);
              onEdit();
            }}
          >
            Forget
          </button>
        </div>
      )}
    </>
  );
}
