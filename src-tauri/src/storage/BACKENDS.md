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
| `tls` | `"none"` plain FTP, `"explicit"` (AUTH TLS on port 21, usual "FTPS"/"FTPES"), `"implicit"` (TLS from the first byte, port 990), `"auto"` (AUTH TLS when offered, plain FTP when refused and the user agreed: FileZilla's "TLS if available", see below) |
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

Certificates: FTPS trusts the system's root certificates (Mozilla's on phones), or the one
certificate the user trusted (`certFingerprint`, below).

### A server's own certificate (FTPS and WebDAV over https)

| field | meaning |
|---|---|
| `certFingerprint` | SHA-256 of the server's leaf certificate, `AB:CD:…` (case, colons and a `SHA256:` prefix don't matter). Empty until the user trusts it |

A server is accepted when its chain checks out as usual, or when its leaf certificate has the
trusted fingerprint (its issuer, name and dates don't matter then, like FileZilla's trust). A
certificate that fails the check fails the connection (`ErrKind::UntrustedCert`) with:

```
The server's security certificate isn't trusted. The server signed it itself. If you know this server, check its certificate and trust it to connect.

cert-untrusted 94:55:1B:…:46:FD
reason: self-signed, wrong-name
host: 10.0.0.5
name: ftp.example.com
issuer: ftp.example.com
valid-from: 2026-11-23
valid-until: 2036-11-20
tls: invalid peer certificate: …
```

`reason` lists `self-signed`, `unknown-issuer`, `wrong-name`, `expired`, `not-yet-valid` or
`other`; `name`, `issuer` and the dates are left out when the certificate doesn't say. On "Trust",
set `profile.net.certFingerprint` to the fingerprint and save/test again.

When another certificate was trusted (`ErrKind::CertChanged`), the first line is
`cert-changed <new fp> expected <saved fp>` and the message reads "The server's certificate changed
since you trusted it. Someone may be intercepting the connection…". The user can still trust the new
one. Errors without a certificate to trust keep "The server's security certificate isn't trusted.
If the server uses its own certificate, Kybl can't connect to it securely." (Rust:
`storage::certtrust`.)

With `"auto"`, a server that refuses AUTH TLS is used over plain FTP only once the user agreed
for that `user@host:port` (the refusal is exactly what someone on the network would forge). Until
then nothing is sent in clear and the connection fails with `ErrKind::Unencrypted`, the detail's
first line being `ftp-plain-unconfirmed`. "Connect without encryption" calls
`ftp_allow_plain({ net })` and connects again. A server that encrypted a connection before, or
lists AUTH TLS in FEAT, is never used unencrypted, agreed or not.

## SFTP (`kind: "sftp"`)

| field | meaning |
|---|---|
| `host`, `port` | port 0 = 22 (`host:2222` also works) |
| `user` | required |
| `auth` | `"password"`, `"key"` or `"agent"` (computers only: `SSH_AUTH_SOCK` on macOS/Linux, the OpenSSH agent pipe or Pageant on Windows) |
| `basePath` | starting folder: absolute, or relative to the home folder (empty = home). It must exist |
| `hostKey` | the trusted server key fingerprint, `SHA256:…` as `ssh-keygen -l` prints it. Empty until the user trusts the server |
| `tunnels` | SSH tunnels (local port forwards): `[{id, name, localPort, remoteHost, remotePort, autoStart}]`, left out when empty. `save_profile` trims and checks them (and gives new ones an id). Run with `tunnel_start` / `tunnel_stop` / `tunnel_list` (desktop), status in `tunnel-status` events; see `src-tauri/src/tunnels` |

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

## Permissions and symbolic links (SFTP, FTP)

Two capabilities, false everywhere else (S3, the blob stores and the cloud drives never offer
them):

| capability | SFTP | FTP | meaning |
|---|---|---|---|
| `permissions` | yes | yes | Unix permissions can be changed: `set_permissions`. FTP uses `SITE CHMOD`; a server without it answers "This FTP server doesn't let Kybl change permissions (it has no SITE CHMOD)." (kind `Unsupported`) |
| `links` | yes | no | symbolic links are told apart, followed, traced (`resolve_link`) and made (`make_link`) |

Listings carry what the server says (fields left out when unknown):

- `mode` (the permission bits, `0o7777` at most), `owner`, `group` on files; for folders the same in
  `folderInfo` (entries keyed like `folders`, only where there is something to say). SFTP v3 gives
  numeric owners; FTP reads MLSD's `UNIX.mode` / `UNIX.owner` / `UNIX.group` (or `uid`/`gid`)
  facts, or the `ls -l` columns of a Unix LIST.
- `link`: a symbolic link's target as stored. The rest of the entry is what it points at, so a
  link to a folder lists as a folder and opens like one; a broken link lists as an empty file.
  FTP only sees links in LIST output (`name -> target`) and lists them as files.

Commands:

- `set_permissions(profileId, bucket, items: [{key, isDir, mode?}], set, clear, recurse?, opId?)`
  → `OpResult`. `set` bits go on and `clear` bits off; bits in neither keep each item's own
  (an item listed without a mode is asked for it; when even that's unknown, every box must be
  decided). `recurse`: `"all"`, `"files"` or `"folders"` also changes what is inside the folders
  among `items` (the picked folders too, unless `"files"`). Links inside aren't followed or
  changed. Progress as `move-progress` with phase `"permissions"`; `cancel_transfer(opId)` stops.
- `resolve_link(profileId, bucket, key)` → the entry the link finally leads to (its key ends
  with `/` for a folder). Errors when it's broken ("The original isn't there any more…",
  `NotFound`) or outside the connection's folder ("The original is outside this connection's
  folder: /path").
- `make_link(profileId, bucket, key, target)`: a link at `key` to `target` (relative to the
  link's folder, or an absolute server path). `Exists` when something has the name.

Deleting a link (to a folder too) removes only the link, never what it points at, and deleting a
folder never follows the links inside it.

Nothing that goes through folders recursively goes into a link to a folder (one pointing back up
would never end): `walk` hands it over as an entry with `link` set (key ending with `/`), so size
counts, searches and `list_all_under` leave it out, and a copy inside the connection makes it a
link again. A transfer job lists it among its failures ("Not copied: this is a link to the
folder…"), and Try again leaves it be. A folder picked by itself is still copied through, even
when it is a link.

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
