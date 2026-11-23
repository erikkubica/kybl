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

fn tag() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// The script that zips `names` (in folder `dir`) into `dest` there, via a temporary name.
pub fn compress_script(dir: &str, names: &[String], dest: &str) -> String {
    let tmp = format!(".{dest}.kybl-{}.part", tag());
    let list = names.iter().map(|n| q(n)).collect::<Vec<_>>().join(" ");
    format!(
        "command -v zip >/dev/null 2>&1 || exit {NO_TOOL}\ncd {d} || exit 1\nzip -q -r -y {t} -- {list} || {{ rm -f {t}; exit 1; }}\nmv -f {t} {f}",
        d = q(dir),
        t = q(&tmp),
        f = q(dest),
    )
}

/// The script that unpacks `archive` into `dir`/`folder` (made if missing; merged into when
/// there, replacing files of the same names), through a temporary folder next to it. Refuses
/// archives with links, absolute names or `..` (exit [`UNSAFE`]).
pub fn extract_script(archive: &str, format: Format, dir: &str, folder: &str) -> String {
    let tmp = format!("{}/.kybl-extract-{}", dir.trim_end_matches('/'), tag());
    let target = format!("{}/{folder}", dir.trim_end_matches('/'));
    let (need, check, unpack) = match format {
        Format::Zip => (
            "unzip",
            // zipinfo: links show as "l" in the mode column; then every name
            "unzip -Z \"$A\" | grep -q '^l' && exit 125\nunzip -Z1 \"$A\" | grep -Eq '(^/|(^|/)\\.\\.(/|$)|^[A-Za-z]:)' && exit 125",
            "unzip -q -o \"$A\" -d \"$T\"",
        ),
        Format::Tar | Format::TarGz => (
            "tar",
            "tar -tvf \"$A\" | grep -q '^[lh]' && exit 125\ntar -tf \"$A\" | grep -Eq '(^/|(^|/)\\.\\.(/|$))' && exit 125",
            if format == Format::TarGz { "tar -xzf \"$A\" -C \"$T\" --no-same-owner 2>/dev/null || tar -xzf \"$A\" -C \"$T\"" } else { "tar -xf \"$A\" -C \"$T\" --no-same-owner 2>/dev/null || tar -xf \"$A\" -C \"$T\"" },
        ),
    };
    format!(
        r#"command -v {need} >/dev/null 2>&1 || exit {NO_TOOL}
A={a}; T={t}; D={d}; F={f}
{check}
mkdir -p "$T" || exit 1
trap 'rm -rf "$T"' EXIT
{unpack} || exit 1
S="$T"
if [ "$(ls -A "$T")" = {fname} ] && [ -d "$T"/{fname} ]; then S="$T"/{fname}; fi
if [ ! -e "$D" ]; then mv "$S" "$D" || exit 1; else cp -R "$S"/. "$D"/ || exit 1; fi
"#,
        a = q(archive),
        t = q(&tmp),
        d = q(&target),
        f = q(folder),
        fname = q(folder),
    )
}

/// Runs a script with `sh` over the connection's SSH session (the shared exec helper, see
/// storage/sftp/command.rs). Ok(None): the server runs no commands for this user.
async fn run(s: &SftpBackend, script: &str, cancel: &AtomicBool) -> SResult<Option<(Option<u32>, String)>> {
    let mut err = Vec::new();
    let end = match s
        .exec(&format!("sh -c {}", q(script)), cancel, |is_err, d| {
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
    let archive = s.remote_path(archive_key).await?;
    let dir = s.remote_path(dest_dir_key).await?;
    match run(s, &extract_script(&archive, format, &dir, folder), cancel).await? {
        Some((Some(0), _)) => Ok(true),
        None | Some((Some(NO_TOOL | UNSAFE) | None, _)) => Ok(false),
        Some((_, err)) => Err(StorageError::other("The server couldn't unpack this archive.").with_detail(err)),
    }
}
