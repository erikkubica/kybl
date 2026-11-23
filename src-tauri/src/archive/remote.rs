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
    let tmp = format!(".{dest}.kybl-{}.part", tag());
    let list = names.iter().map(|n| q(n)).collect::<Vec<_>>().join(" ");
    format!(
        "command -v zip >/dev/null 2>&1 || exit {NO_TOOL}; cd {d} || exit 1; T={t}; {stop}; {zip} || {{ rm -f \"$T\"; exit 1; }}; if [ -d {f} ]; then rm -f \"$T\"; echo \"A folder has that name.\" >&2; exit 1; fi; mv -f \"$T\" {f}",
        d = q(dir),
        t = q(&tmp),
        f = q(dest),
        stop = on_stop("rm -f \"$T\""),
        zip = waited(&format!("zip -q -r -y \"$T\" -- {list}")),
    )
}

/// The script that unpacks `archive` into `dir`/`folder` (made if missing; merged into when
/// there, replacing files of the same names), through a temporary folder next to it. Refuses
/// archives with links, absolute names or `..` (exit [`UNSAFE`]), and archives it can't list (a
/// listing that fails proves nothing about the entries).
pub fn extract_script(archive: &str, format: Format, dir: &str, folder: &str) -> String {
    let tmp = format!("{}/.kybl-extract-{}", dir.trim_end_matches('/'), tag());
    let target = format!("{}/{folder}", dir.trim_end_matches('/'));
    // the listing is kept first, so a lister that fails stops the unpack
    let listed = |list: &str, pattern: &str| format!("L=$({list} 2>/dev/null) || exit {UNSAFE}; printf '%s\\n' \"$L\" | grep -Eq {pattern} && exit {UNSAFE}");
    let (need, check, unpack) = match format {
        Format::Zip => (
            "unzip",
            // zipinfo: links show as "l" in the mode column; then every name
            format!(
                "{}; {}",
                listed("unzip -Z \"$A\"", "'^l'"),
                listed("unzip -Z1 \"$A\"", "'(^/|(^|/)\\.\\.(/|$)|^[A-Za-z]:|\\\\)'")
            ),
            waited("unzip -q -o \"$A\" -d \"$T\""),
        ),
        Format::Tar | Format::TarGz => {
            let z = if format == Format::TarGz { "z" } else { "" };
            (
                "tar",
                format!("{}; {}", listed("tar -tvf \"$A\"", "'^[lh]'"), listed("tar -tf \"$A\"", "'(^/|(^|/)\\.\\.(/|$)|\\\\)'")),
                format!(
                    "{} || {{ {}; }}",
                    waited(&format!("tar -x{z}f \"$A\" -C \"$T\" --no-same-owner 2>/dev/null")),
                    waited(&format!("tar -x{z}f \"$A\" -C \"$T\""))
                ),
            )
        }
    };
    format!(
        "command -v {need} >/dev/null 2>&1 || exit {NO_TOOL}; A={a}; T={t}; D={d}; F={f}; {check}; mkdir -p \"$T\" || exit 1; trap 'rm -rf \"$T\"' EXIT; {stop}; {unpack} || exit 1; \
         S=\"$T\"; if [ \"$(ls -A \"$T\")\" = {fname} ] && [ -d \"$T\"/{fname} ]; then S=\"$T\"/{fname}; fi; \
         if [ ! -e \"$D\" ]; then mv \"$S\" \"$D\" || exit 1; else L=$(find \"$D\" -type l 2>/dev/null) || exit {UNSAFE}; [ -z \"$L\" ] || exit {UNSAFE}; cp -R \"$S\"/. \"$D\"/ || exit 1; fi",
        a = q(archive),
        t = q(&tmp),
        d = q(&target),
        f = q(folder),
        fname = q(folder),
        stop = on_stop("rm -rf \"$T\""),
    )
}

/// Runs a script with `sh` over the connection's SSH session (the shared exec helper, see
/// storage/sftp/command.rs). Ok(None): the server runs no commands for this user.
async fn run(s: &SftpBackend, script: &str, cancel: &AtomicBool) -> SResult<Option<(Option<u32>, String)>> {
    // a name with a line break or another control character: the download/upload path takes it
    let Some(command) = crate::actions::sh_c(script) else { return Ok(None) };
    let mut err = Vec::new();
    let end = match s
        .exec(&command, cancel, |is_err, d| {
            if is_err && err.len() < 64 * 1024 {
                err.extend_from_slice(d);
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
