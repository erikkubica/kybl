# Google OAuth verification: the Drive scope

Kybl's Google Drive connection asks for one scope, `https://www.googleapis.com/auth/drive`
(`src-tauri/src/oauth/mod.rs`). It is a **restricted** scope, so Google reviews it with a demo
video. The first video (connect, upload, delete, Settings) was turned down because it showed *what*
Kybl does with Drive, not *why* a narrower scope can't do it. This is the plan for the next one.

## What Google asked for

- **In-app functionality**: the full use of every requested scope.
- **Source account impact**: each write or delete in Kybl shown happening in the Google account.
- **Consent screen**: the OAuth consent flow with every scope expanded and readable.
- **Scope matching**: the scopes the app asks for must equal the ones in the Cloud Console. Kybl
  asks only for `auth/drive`, so the console must list exactly that one.

## The argument

- **Why not `drive.file`?** It only sees files Kybl created or the user opened with Kybl, so a
  user's existing Drive would look empty.
- **What Kybl needs it for**: Kybl is a file manager for the whole Drive. It browses, opens,
  organises and deletes files made elsewhere: in the Drive web app, on the phone, or shared by
  other people.
- **Why not `drive.readonly` or `drive.metadata`?** They can't rename, move, edit or delete.

## Shot list

Record Kybl and drive.google.com side by side, with on-screen captions.

1. **Consent**: in Kybl, add a Google Drive connection. On Google's screen, expand the scope until
   "See, edit, create, and delete all of your Google Drive files" is readable, then Allow.
2. **Existing files**: open My Drive in Kybl. Show folders and files that were made in the Drive
   web app, not by Kybl. Caption: *"With drive.file, none of these would be visible."*
3. **Shared drives and Shared with me**: open both roots. Caption: these hold files Kybl didn't
   create.
4. **Read**: open a file made elsewhere in Quick Look, and download a Google Doc as PDF.
5. **Write, each reflected in Drive**:
   - upload a file;
   - rename a file that was made in the web UI;
   - move it to another folder;
   - create a folder;
   - edit a text file in Kybl and save it.

   Refresh drive.google.com after each one so the change shows there.
6. **Delete**: delete a file that was made in the web UI. Kybl moves it to Drive's Trash
   (`trash: true`), so show it arriving in **Trash** on drive.google.com.
7. **Across clouds**: copy a folder from Drive to S3 (or the other way). Optionally set up folder
   sync.
8. **Revoke**: remove the connection in Kybl, and show that its access can be revoked at
   myaccount.google.com → Security → Third-party connections.

Don't show share links: Kybl doesn't create them for Drive (they would be permanent public
permissions).

## Reply to the review email

Reply in the same thread, with the new video's link:

> Thank you for the review. We've uploaded a new demo video: [link].
>
> Kybl is a desktop file manager (Windows, macOS, Linux) that shows the user's whole Google Drive
> like a local disk: My Drive, shared drives and Shared with me. Users browse, open, download,
> upload, rename, move, copy (including to other cloud storage) and delete files, almost all of
> them created outside Kybl in the Drive web app or other apps.
>
> `drive.file` would only expose files Kybl created, so the user's existing Drive would appear
> empty. `drive.readonly` can't rename, move, edit or delete.
>
> The video shows the consent screen with the scope expanded. It then shows each operation on
> files created outside Kybl, each reflected in drive.google.com, including a deletion landing in
> Drive's Trash.
>
> Kybl talks to the Drive API directly from the user's device; file contents are not sent to our
> servers. We request only `https://www.googleapis.com/auth/drive`, which matches the
> configuration in the Cloud Console.

Before sending, check that the last paragraph still holds. Today Drive traffic goes straight from
the app to Google, and Kybl Cloud never sees it.

## While the app is unverified

- Up to 100 test users can sign in. Each one sees the "unverified app" warning.
- Record the demo with the same OAuth client and project that is under review.
- Keep the publishing status **In production**.
