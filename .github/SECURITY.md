# Security policy

Kybl holds the keys to people's storage, so security reports are taken seriously and answered
quickly.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately instead, through
[GitHub's private vulnerability reporting](https://github.com/erikkubica/kybl/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. Expect a reply
within a few days. Once a fix is released, the report is credited in the advisory unless you'd
rather stay anonymous.

## Supported versions

Only the latest release gets security fixes. Kybl updates itself (Settings → General → About).

## In scope

- **Credentials**: how they are stored. Keys and passwords live in the system's secret store
  (Keychain, Credential Manager, the Secret Service) or, on Android, in the app's private storage.
- **Remote files**: opening or running files from a connection.
- **Network**:
  - TLS and certificate handling;
  - SSH host keys;
  - FTP encryption.
- **Kybl Storage**:
  - sign-in and the account site;
  - encryption at rest (SSE-C).
- **The update process**, and the signatures on releases.
- **The built-in terminal**, including what gets typed or pasted into it.

## Out of scope

- Problems in the storage services themselves (S3, Google Drive and so on): please report those to
  their provider.
- Attacks that need someone who already controls your unlocked computer.
