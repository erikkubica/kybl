# Cloud drive sign-in (Google Drive, OneDrive, Dropbox)

For the connections UI (WP-A3) and for whoever registers the OAuth apps. Code: `mod.rs` (flow,
providers, commands), `token.rs` (refresh), `http.rs` (signed requests, retries, errors). The
backends are `storage/gdrive/`, `storage/onedrive.rs` and `storage/dropbox.rs`.

## The calls (src/api.ts, "WP-A2")

| Call | What it does |
|---|---|
| `oauthBuiltinClients()` | `{gdrive, onedrive, dropbox}`: true when this build has its own client ID for that provider |
| `oauthStart(kind, flowId, client?, replaceId?)` | opens the browser, waits for the sign-in, saves the connection and resolves with the `Profile` |
| `oauthCancel(flowId)` | stops a sign-in that is waiting; `oauthStart` then rejects with `"Cancelled"` |
| event `connection-auth` `{profileId}` | that connection's access is gone (revoked, expired, password changed): show Reconnect |

`flowId` is any unique string the UI makes up (e.g. `crypto.randomUUID()`), used only to cancel.

### New connection

1. On opening the "Add connection" kind picker, call `oauthBuiltinClients()`.
2. For a kind that is `false`, show **"Needs your own client ID"** and open the Advanced section
   by default: a client ID field (required), a client secret field (Google only; "Desktop app"
   clients have one), and for OneDrive an optional tenant field (organization id or domain, empty
   = any account). For a kind that is `true`, keep those fields under a collapsed **"Use your own
   OAuth app"** (optional).
3. "Sign in with Google" (etc.) → `oauthStart(kind, flowId, client)` where `client` is
   `{clientId, clientSecret, tenant}` or `null`. While it waits, show "Finish signing in in your
   browser" with a Cancel button → `oauthCancel(flowId)`.
4. It resolves with the saved profile (`kind`, `provider` = kind, `name` = "Google Drive
   (me@gmail.com)", `cloud.accountEmail`). Refresh the connection list and open it. Signing in to
   an account that already has a connection updates that one (same id) instead of adding a
   duplicate.

Errors are the usual "plain sentence\n\ndetails" strings (`errSummary` / `errDetail`). Examples:
no built-in client, the browser couldn't open, a busy port (Dropbox), the provider refused the
client ID.

### Reconnect

On `connection-auth` (listen once, app-wide) mark that profile as needing sign-in: a **Reconnect**
button in the sidebar entry and in the error state of its browser view. Any command on it also
fails with "Kybl is no longer signed in to your Google Drive. Reconnect to keep using it."

Reconnect = `oauthStart(profile.kind, flowId, null, profile.id)`. It keeps the profile id (open
tabs, sync folders, jobs stay pointed at it) and its name, reuses the user's own client ID if the
connection had one, and pre-fills the account (Google, Microsoft). Signing in with a *different*
account is refused with a message naming the right one.

### Editing and removing

`saveProfile` works as for any connection (rename). Don't send a `secret`: there is none.
`deleteProfile` also removes the tokens (`{id}#oauth`). Changing the client ID of an existing
connection = Reconnect with a `client`.

### What the connections can do

From `capabilities(profileId)`; summary:

| | Google Drive | OneDrive | Dropbox |
|---|---|---|---|
| roots | `drives`: My Drive, each shared drive, "Shared with me" (read-only at its top) | `drives`: OneDrive, "Shared with me" | `single` (id `""`) |
| delete | to Drive's trash (`trash: true`) | to the recycle bin | restorable on dropbox.com |
| share | `none` (Drive links are permanent public permissions; previews must not create them) | `link`: an hour or less = temporary download address; longer = view-only anonymous link with expiry | `link`: four hours or less = temporary link; longer = public link with expiry (paid plans) |
| streaming | `proxy` (needs `media://`, WP-A4) | `presign` (the download address takes ranges) | `presign` |
| conditional write | `compare` | `if-match` | `rev` |
| hashes | md5 | quickxor | dropbox |
| thumbnails | `local+remote` | `local+remote` | `local+remote` |

**Google Docs, Sheets, Slides** list with `size: 0` and `native.exports` (first = Office format).
Reading the key returns the first export, so a download should be saved as
`key + "." + native.exports[0].ext`. "Download as PDF" = download `key + ".pdf"` (any export's
extension works). They can't be overwritten. Google Forms / Sites have `exports: []`: hide
download for them. `native.webUrl` is where the file opens in the browser (its `webViewLink`, or
`https://drive.google.com/open?id=…` for a shortcut); a mounted drive shows every such file as a
`Name.gdoc.html` (`.gsheet`, `.gslides`, `.gform`, …) page that opens it (`mount/link.rs`).

**Duplicate names** (Drive allows several "report.pdf" in one folder) list as "report.pdf",
"report (2).pdf", … oldest first; the same names work in every command. A "/" inside a Drive name
shows as "／".

## The flow per platform

PKCE (S256) and a random `state` everywhere. The refresh token goes into the vault as
`{id}#oauth` (`{"refreshToken","clientId","clientSecret"?}`); access tokens stay in memory.

| | Computer | Android | iPhone |
|---|---|---|---|
| Google | system browser → `http://127.0.0.1:<any port>/callback` | Custom Tab → the same loopback address on the phone; Kybl's answer redirects to `kybl://oauth/done`, which closes the tab | built-in iOS client: sign-in sheet → `com.googleusercontent.apps.<id>:/oauth2redirect`; the user's own client: loopback in the sheet, like Android |
| Microsoft | browser → `http://localhost:<any port>/callback` | Custom Tab → `kybl://oauth/onedrive` | sheet → `kybl://oauth/onedrive` |
| Dropbox | browser → `http://localhost:53682/callback` (or 53683 if busy) | Custom Tab → the same, then `kybl://oauth/done` | sheet → the same, then `kybl://oauth/done` |

Phones use `KyblConnectPlugin` (`signIn {url, callbackScheme}`), shared with "Connect Kybl
Storage". Android catches `kybl://oauth/*` with an intent filter (`AndroidManifest.xml`); the iOS
sheet doesn't need the scheme registered.

**Not tested on devices yet:** the loopback-in-a-Custom-Tab flow (Google, Dropbox) on Android —
the spec's risk 2 — and the loopback-in-a-sheet flow on iOS. If Chrome on Android refuses to
follow the 302 to `kybl://oauth/done`, the code still arrives (the tab just stays open until the
user switches back, and `cancel` then brings Kybl forward). Fallback if Google blocks loopback
on Android: Play Services `AuthorizationClient` (no refresh token; needs a re-authorize on each
launch).

Refresh: single flight per connection; when less than two minutes are left or after a 401 (once);
Microsoft's rotated refresh tokens are saved at once; `invalid_grant` / `invalid_client` → the
`connection-auth` event and NeedsAuth errors until Reconnect.

## What the owner has to register

Set these GitHub secrets (all optional; an unset one leaves that provider on "Needs your own
client ID"): `KYBL_GOOGLE_CLIENT_ID`, `KYBL_GOOGLE_CLIENT_SECRET`, `KYBL_GOOGLE_IOS_CLIENT_ID`,
`KYBL_MS_CLIENT_ID`, `KYBL_DROPBOX_APP_KEY`. For a local build, export them before `cargo`/`tauri`.

**Google Cloud** (console.cloud.google.com):
- A project with the **Google Drive API** enabled and an OAuth consent screen (app name Kybl,
  privacy policy, kybl.app as authorized domain).
- Scope: `https://www.googleapis.com/auth/drive` — **restricted**. Until the app is verified,
  at most 100 users, who see an "unverified app" warning; verification needs a privacy policy,
  the verified domain, a demo video and takes weeks. Ship as "bring your own client ID" first,
  built-in as beta.
- An OAuth client of type **Desktop app** → `KYBL_GOOGLE_CLIENT_ID` + `KYBL_GOOGLE_CLIENT_SECRET`
  (the secret isn't secret for desktop apps; Google expects it compiled in). No redirect URI to
  register: loopback is allowed for Desktop clients. Used on computers and Android.
- An OAuth client of type **iOS** with bundle id `app.kybl.mobile` (`gen/apple/project.yml`)
  → `KYBL_GOOGLE_IOS_CLIENT_ID`. Its redirect is the reversed client id (no registration).
  AltStore/SideStore re-sign the app under another bundle id; the custom-scheme redirect should
  still work, but check it on a sideloaded build. Without this secret iPhones use the Desktop
  client over loopback, like Android.

**Microsoft Entra** (entra.microsoft.com → App registrations):
- New registration: "Accounts in any organizational directory and personal Microsoft accounts".
- Authentication → platform **Mobile and desktop applications**, redirect URIs
  `http://localhost/callback` and `kybl://oauth/onedrive`; "Allow public client flows" = yes.
  No client secret.
- API permissions (delegated): `Files.ReadWrite.All`, `User.Read`, `offline_access`.
- Application (client) ID → `KYBL_MS_CLIENT_ID`.
- **Publisher verification** (free Microsoft Partner Network id), otherwise many work tenants
  block user consent.

**Dropbox** (dropbox.com/developers/apps):
- Scoped app, "Full Dropbox" access.
- Permissions: `account_info.read`, `files.metadata.read`, `files.metadata.write`,
  `files.content.read`, `files.content.write`, `sharing.read`, `sharing.write`.
- OAuth 2 redirect URIs: `http://localhost:53682/callback` and `http://localhost:53683/callback`.
  "Allow public clients (Implicit Grant & PKCE)" = allow.
- App key → `KYBL_DROPBOX_APP_KEY` (no secret: PKCE).
- Apply for **production** status once past the development user limit.

People using their own client register the same redirects with their own app.

## Known gaps

- Nothing here has run against the real services: everything is tested against a local stand-in
  server (listing, paging, duplicate names, exports, resumable and session uploads, rate limits,
  token refresh). Expect small API mismatches on first real use.
- OneDrive "Shared with me" uses `/me/drive/sharedWithMe`, which Microsoft has deprecated; folders
  "added to My files" from someone else may not open by path.
- Dropbox team spaces: only the member folder (no `Dropbox-API-Path-Root`).
- Drive change lists name files by their raw Drive names (no " (2)" numbering).
- Drive `share` is off; a "Share in Google Drive" (anyone-with-link) action could be added as an
  explicit, separate UI action later.
