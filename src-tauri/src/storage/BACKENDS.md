# Server and blob backends: settings, secrets, errors

For the connection forms (package A3). Every kind below is a `Profile` with `kind` set, saved
with `save_profile(profile, secret)` and tried with `test_connection(profile, secret)` (which
opens the backend and calls `roots()`: that connects, signs in and checks the starting folder,
so its error is the one to show).

All of them have one root (`caps.roots = "single"`, root id `""`), named after the host and base
folder (or the container/bucket).

## WebDAV (`kind: "webdav"`)

`net` fields:

| field | meaning |
|---|---|
| `url` | the full address, e.g. `https://cloud.example.com/remote.php/dav/files/alice/`. Preferred. `davs://` and `webdav://` are accepted. When it's only a server (`https://cloud.example.com`) and a user is set, Kybl also tries Nextcloud/ownCloud's `/remote.php/dav/files/{user}/` (and `/nextcloud/...`) |
| `host`, `port`, `tls` | used when `url` is empty: `tls: "none"` is `http://`, anything else `https://`; `port` 0 = 80/443 |
| `user` | user name (Basic auth). Empty: no sign-in |
| `basePath` | folder under the address to start in (optional) |

Secret: the password (or an app password: Nextcloud/ownCloud with two-factor sign-in need one).

Capabilities: real folders, native rename (MOVE), server copy (COPY), range reads, conditional
writes (`if-match`; also checked by reading first, for servers that ignore it). Uploads stream
from disk; uploads to Nextcloud/ownCloud above 64 MB go in 16 MB chunks (each retried). Other
uploads go to a temporary name and are moved over the target, so a cancelled upload leaves nothing.
Quota comes from `quota-used-bytes` / `quota-available-bytes` where the server reports them.

Warn when the address is `http://` (or `tls: "none"`): the password and files travel unencrypted.

## FTP / FTPS (`kind: "ftp"`)

| field | meaning |
|---|---|
| `host` | server name or address (`ftp.example.com`, `ftp.example.com:2121` also works) |
| `port` | 0 = 21, or 990 with implicit TLS |
| `tls` | `"none"` plain FTP, `"explicit"` (AUTH TLS on port 21, usual "FTPS"/"FTPES"), `"implicit"` (TLS from the first byte, port 990) |
| `user` | user name; empty signs in as `anonymous` |
| `basePath` | starting folder: absolute (`/var/www`) or relative to the login folder. It must exist |

Secret: the password.

**Plain FTP (`tls: "none"`) is insecure**: the password and every file cross the network in the
clear. The form should show a warning whenever `tls === "none"` (there is no capability field for
it; it's a property of the settings).

Passive mode (with the NAT fix for servers announcing a private address; extended passive over
IPv6), UTF-8 names, MLSD listings with LIST as fallback. Up to 4 connections per server.
Capabilities: real folders, native rename, range reads (REST), conditional writes by comparing
(`compare`), no server copy (copies go through Kybl). Uploads go to `.name.kybl-…` and are
renamed onto the target (servers refusing dot names get the file written in place).

Certificates: FTPS trusts the system's root certificates (Mozilla's on phones). A server with a
self-signed certificate is refused with "The server's security certificate isn't trusted…".

## SFTP (`kind: "sftp"`)

| field | meaning |
|---|---|
| `host`, `port` | port 0 = 22 (`host:2222` also works) |
| `user` | required |
| `auth` | `"password"`, `"key"` or `"agent"` (computers only: `SSH_AUTH_SOCK` on macOS/Linux, the OpenSSH agent pipe or Pageant on Windows) |
| `basePath` | starting folder: absolute, or relative to the home folder (empty = home). It must exist |
| `hostKey` | the trusted server key fingerprint, `SHA256:…` as `ssh-keygen -l` prints it. Empty until the user trusts the server |

Secrets:

- `auth: "password"`: the password, as the connection's secret (`{id}`). Also used to answer
  keyboard-interactive prompts.
- `auth: "key"`: the private key, as JSON `{"privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----…", "passphrase": "…"}`
  (or just the key text when it has no passphrase). OpenSSH, PEM (PKCS#1/PKCS#8) and PuTTY `.ppk`
  keys work; Ed25519, ECDSA and RSA. Stored under `{id}#ssh` (`state::secret_key(id, "ssh")`);
  a key passed as the `secret` of `save_profile` (stored under `{id}`) or of `test_connection`
  is used too, so the form can send it the same way as a password.
- `auth: "agent"`: nothing.

### Trust on first use

The first connection to a server fails (from `test_connection`, or any command) with:

```
Kybl hasn't connected to this server before. Check that the server's fingerprint matches, then trust it to connect.

host-key-unknown SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8
```

Parse the fingerprint with `/host-key-unknown (SHA256:\S+)/`, show it with a "Trust this server?"
prompt, and on yes set `profile.net.hostKey` to it and save/test again.

When the saved key doesn't match, the error is a hard stop, with no way to continue from it:

```
The server's identity changed. Someone may be intercepting the connection, so Kybl didn't connect. If the server was reinstalled or its key replaced, remove the saved fingerprint in the connection's settings and connect again.

host-key-changed SHA256:<new> expected SHA256:<saved>
```

(Rust side: `ErrKind::UnknownHost` / `ErrKind::HostKeyChanged`, `sftp::hostkey`.)

Capabilities: real folders, native rename (posix-rename where the server has it), range reads,
conditional writes by comparing, no server copy. One SSH connection per server carries
everything, with keepalives; a dropped connection is reopened on the next request. Uploads go
to a temporary name and are renamed over the target. Quota from statvfs (OpenSSH).

## Azure Blob Storage (`kind: "azblob"`)

`blob` fields: `account` (storage account name), `container` (required: one container per
connection), `endpoint` (optional: Azurite or a sovereign cloud; default
`https://{account}.blob.core.windows.net`).

Secret: the account key, or a SAS token (starting with `?`, or containing `sig=`).

Capabilities: prefix folders (like S3), rename by copy and delete, server copy, range reads,
`if-match` conditional writes, MD5 hashes.

## Google Cloud Storage (`kind: "gcs"`)

`blob` fields: `container` (the bucket, required), `endpoint` (optional). `account` is unused.

Secret: the service account's JSON key file contents.

Capabilities: as Azure, with conditional writes by comparing.

## Errors

Errors come back as the usual string, "plain sentence\n\ndetails". Sign-in failures read
"Wrong user name or password." (and similar, kind `NeedsAuth`), unreachable servers
"Couldn't reach {host}…" / "Couldn't find {host}. Check the address." / "{host} didn't answer in
time…", certificate and encryption problems say so.
