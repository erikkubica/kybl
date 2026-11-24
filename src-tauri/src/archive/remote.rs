//! SFTP: zipping and unpacking on the server itself over an SSH exec channel, instead of
//! downloading everything, (un)packing here and uploading it again. Each script exits 127 when
//! the server lacks the tool (or runs no commands at all), and the caller falls back to the
//! download/upload path; 125 when the archive holds links or unsafe names, which only the
//! client-side path knows how to leave out.

use std::sync::atomic::{AtomicBool, Ordering};

use super::index::Format;
use crate::actions::quote as q;
use crate::storage::{sftp::SftpBackend, SResult, StorageError};

/// Exit status of a script whose tool is missing.
const NO_TOOL: u32 = 127;
/// Exit status when the archive has entries the server-side unpack must not touch.
const UNSAFE: u32 = 125;

/// Whether `folder` is one plain folder name to unpack into: not empty, `.` or `..`, and no
/// separator or NUL (an archive called `...zip` must not unpack into the parent folder).
pub fn plain_folder_name(folder: &str) -> bool {
    !folder.is_empty() && folder != "." && folder != ".." && !folder.contains(['/', '\\', '\0'])
}

fn tag() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// `cmd` run in the background and waited for, its pid in `$P`: a signal then reaches the script
/// at once (a foreground child holds traps back until it ends), and the trap can stop it.
fn waited(cmd: &str) -> String {
    format!("{cmd} & P=$!; wait $P")
}

/// Stop (TERM from the app, HUP when the connection drops, INT): the tool in `$P` is stopped and
/// waited for, then `cleanup` runs.
fn on_stop(cleanup: &str) -> String {
    format!("P=; trap 'kill $P 2>/dev/null; wait; {cleanup}; exit 1' HUP INT TERM")
}

/// The script that zips `names` (in folder `dir`) into `dest` there, via a temporary name. One
/// line: csh would read a line break inside the quotes as the end of the command.
pub fn compress_script(dir: &str, names: &[String], dest: &str) -> String {
    // cut to the name limit (".", ".kybl-", the tag and ".part" around it)
    let tmp = format!(".{}.kybl-{}.part", crate::storage::net::fit_name(dest, 1 + 6 + 8 + 5), tag());
    let list = names.iter().map(|n| q(n)).collect::<Vec<_>>().join(" ");
    format!(
        "command -v zip >/dev/null 2>&1 || exit {NO_TOOL}; cd {d} || exit 1; T={t}; {stop}; {zip} || {{ rm -f \"$T\"; exit 1; }}; if [ -d {f} ]; then rm -f \"$T\"; echo \"A folder has that name.\" >&2; exit 1; fi; {gone}; if ln -- \"$T\" {f} 2>/dev/null; then rm -f \"$T\"; else {gone}; mv -- \"$T\" {f}; fi",
        d = q(dir),
        t = q(&tmp),
        f = q(dest),
        stop = on_stop("rm -f \"$T\""),
        zip = waited(&format!("zip -q -r -y \"$T\" -- {list}")),
        // never over a file that turned up while it packed: a hard link refuses a name that is
        // there; a disk without hard links gets a look first
        gone = format!("if [ -e {f} ] || [ -L {f} ]; then rm -f \"$T\"; echo \"A file has that name.\" >&2; exit 1; fi", f = q(dest)),
    )
}

/// The script that unpacks `archive` into `dir`/`folder` (made if missing; merged into when
/// there, replacing files of the same names), through a temporary folder next to it that only
/// this account can enter. The archive is copied in there first and only that copy is listed and
/// unpacked, so nobody can swap it between the check and the unpack. Refuses archives with
/// anything but plain files and folders (links, devices, FIFOs), absolute names or `..` (exit
/// [`UNSAFE`]), and archives it can't list (a listing that fails proves nothing about the
/// entries). Set-user-ID and set-group-ID bits are never kept (the account may be root), and
/// nothing comes out writable by the group or others.
pub fn extract_script(archive: &str, format: Format, dir: &str, folder: &str) -> String {
    let tmp = format!("{}/.kybl-extract-{}", dir.trim_end_matches('/'), tag());
    let target = format!("{}/{folder}", dir.trim_end_matches('/'));
    // the listing is kept first, so a lister that fails stops the unpack
    let listed = |list: &str, filter: &str, pattern: &str| format!("L=$({list} 2>/dev/null) || exit {UNSAFE}; printf '%s\\n' \"$L\" {filter}| grep -Eq {pattern} && exit {UNSAFE}");
    let (need, check, unpack) = match format {
        Format::Zip => (
            "unzip",
            // zipinfo: an entry line starts with its mode (header and totals lines left out);
            // "-" a file, "d" a folder, "?" an entry with no type bits (Python's writestr), which
            // unzip writes as a plain file; then every name
            format!(
                "{}; {}",
                listed("unzip -Z \"$A\"", "| grep -Ev '^(Archive:  |Zip file size: |[0-9]+ files?, )' ", "'^[^-d?]'"),
                listed("unzip -Z1 \"$A\"", "", "'(^/|(^|/)\\.\\.(/|$)|^[A-Za-z]:|\\\\)'")
            ),
            waited("unzip -q -o \"$A\" -d \"$X\""),
        ),
        Format::Tar | Format::TarGz => {
            let z = if format == Format::TarGz { "z" } else { "" };
            (
                "tar",
                format!("{}; {}", listed("tar -tvf \"$A\"", "", "'^[^-d]'"), listed("tar -tf \"$A\"", "", "'(^/|(^|/)\\.\\.(/|$)|\\\\)'")),
                format!(
                    "{} || {{ {}; }}",
                    waited(&format!("tar -x{z}f \"$A\" -C \"$X\" --no-same-owner --no-same-permissions 2>/dev/null")),
                    waited(&format!("tar -x{z}f \"$A\" -C \"$X\""))
                ),
            )
        }
    };
    format!(
        "command -v {need} >/dev/null 2>&1 || exit {NO_TOOL}; A={a}; T={t}; D={d}; F={f}; X=\"$T/x\"; \
         mkdir -m 700 \"$T\" || exit 1; trap 'rm -rf \"$T\"' EXIT; {stop}; {copy} || exit 1; A=\"$T/a\"; \
         {check}; mkdir \"$X\" || exit 1; {unpack} || exit 1; \
         L=$(find \"$X\" ! -type f ! -type d 2>/dev/null) || exit {UNSAFE}; [ -z \"$L\" ] || exit {UNSAFE}; \
         chmod -R u+rwX,go-w,ug-s \"$X\" || exit 1; \
         S=\"$X\"; if [ \"$(ls -A \"$X\")\" = {fname} ] && [ -d \"$X\"/{fname} ]; then S=\"$X\"/{fname}; fi; \
         if [ ! -e \"$D\" ]; then mv \"$S\" \"$D\" || exit 1; else L=$(find \"$D\" -type l 2>/dev/null) || exit {UNSAFE}; [ -z \"$L\" ] || exit {UNSAFE}; cp -R \"$S\"/. \"$D\"/ || exit 1; fi",
        a = q(archive),
        t = q(&tmp),
        d = q(&target),
        f = q(folder),
        fname = q(folder),
        stop = on_stop("rm -rf \"$T\""),
        copy = waited("cp -- \"$A\" \"$T/a\""),
    )
}

/// Printed first by every script, so a run that ended before it got that far (a restricted
/// shell that can't `exec /bin/sh`, say) is told apart from a tool that failed.
const STARTED: &str = "kybl:started";

/// Whether a script's end means it never ran at all: it failed and never printed [`STARTED`].
pub(crate) fn never_started(code: Option<u32>, out: &[u8]) -> bool {
    code != Some(0) && !String::from_utf8_lossy(out).lines().any(|l| l.trim_end_matches('\r') == STARTED)
}

/// `script` with the [`STARTED`] line first.
pub(crate) fn marked(script: &str) -> String {
    format!("echo {STARTED}; {script}")
}

/// Runs a script with `sh` over the connection's SSH session (the shared exec helper, see
/// storage/sftp/command.rs). Ok(None): the server runs no commands for this user, or not this
/// script (it never started: the other path takes over).
async fn run(s: &SftpBackend, script: &str, cancel: &AtomicBool) -> SResult<Option<(Option<u32>, String)>> {
    // a name with a line break or another control character: the download/upload path takes it
    let Some(command) = crate::actions::sh_c(&marked(script)) else { return Ok(None) };
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let end = match s
        .exec(&command, cancel, |is_err, d| {
            let buf = if is_err { &mut err } else { &mut out };
            if buf.len() < 64 * 1024 {
                buf.extend_from_slice(d);
            }
        })
        .await
    {
        Ok(e) => e,
        // no exec channel (SFTP-only accounts, chroots): the download/upload path still works
        Err(_) if !cancel.load(Ordering::Relaxed) => return Ok(None),
        Err(e) => return Err(e),
    };
    if end.stopped {
        return Err(StorageError::cancelled());
    }
    if never_started(end.code, &out) {
        return Ok(None);
    }
    Ok(Some((end.code, String::from_utf8_lossy(&err).trim().to_string())))
}

/// Zips on the server. Ok(false): it can't here (no `zip`, no shell), use the other path.
pub async fn compress(s: &SftpBackend, dir_key: &str, names: &[String], dest_name: &str, cancel: &AtomicBool) -> SResult<bool> {
    let dir = s.remote_path(dir_key).await?;
    match run(s, &compress_script(&dir, names, dest_name), cancel).await? {
        Some((Some(0), _)) => Ok(true),
        None | Some((Some(NO_TOOL) | None, _)) => Ok(false),
        Some((_, err)) => Err(StorageError::other("The server couldn't zip these files.").with_detail(err)),
    }
}

/// Unpacks on the server. Ok(false): it can't here, use the other path.
pub async fn extract(s: &SftpBackend, archive_key: &str, format: Format, dest_dir_key: &str, folder: &str, cancel: &AtomicBool) -> SResult<bool> {
    if !plain_folder_name(folder) {
        return Err(StorageError::other("That folder name can't be used to unpack into."));
    }
    let archive = s.remote_path(archive_key).await?;
    let dir = s.remote_path(dest_dir_key).await?;
    match run(s, &extract_script(&archive, format, &dir, folder), cancel).await? {
        Some((Some(0), _)) => Ok(true),
        None | Some((Some(NO_TOOL | UNSAFE) | None, _)) => Ok(false),
        Some((_, err)) => Err(StorageError::other("The server couldn't unpack this archive.").with_detail(err)),
    }
}
