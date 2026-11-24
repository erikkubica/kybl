//! Reading an archive's table of contents: which files and folders it holds, where each one's
//! bytes are, and which entries are left out because they are unsafe to unpack.
//!
//! Every name goes through [`safe_key`] before it becomes a key, so nothing listed (and therefore
//! nothing extracted or copied out) can point outside the folder it is unpacked into ("zip slip":
//! `../../.ssh/authorized_keys`, `/etc/passwd`, `C:\Windows\…`). Links (symbolic and hard) are
//! left out too: a link followed by a file written "through" it is the other classic escape.

use std::{
    collections::{BTreeSet, HashMap},
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc},
};

use serde::Serialize;

/// More entries than this is not an archive anyone browses; it is refused rather than indexed.
pub const MAX_ENTRIES: usize = 500_000;
/// Unpacked sizes past this many times the archive's own size (and past [`BOMB_FLOOR`]) are a
/// decompression bomb, not data: such archives are refused.
pub const BOMB_RATIO: u64 = 200;
pub const BOMB_FLOOR: u64 = 1 << 30;
/// Nothing unpacks to more than this, whatever the ratio.
pub const MAX_TOTAL: u64 = 1 << 40;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Zip,
    Tar,
    TarGz,
}

impl Format {
    /// By the file name: `.zip`, `.tar`, `.tar.gz` / `.tgz`.
    pub fn of(name: &str) -> Option<Format> {
        let n = name.to_ascii_lowercase();
        if n.ends_with(".zip") {
            Some(Format::Zip)
        } else if n.ends_with(".tar.gz") || n.ends_with(".tgz") {
            Some(Format::TarGz)
        } else if n.ends_with(".tar") {
            Some(Format::Tar)
        } else {
            None
        }
    }
}

/// A name from inside an archive as a safe key below the folder it unpacks into, or None when it
/// must not be unpacked: absolute paths, drive letters, `..` anywhere, NUL bytes. Backslashes count
/// as separators (archives made on Windows), `.` and empty parts are dropped. Folders keep their
/// trailing `/`; the bare top ("", "./") is None.
pub fn safe_key(raw: &str, is_dir: bool) -> Option<String> {
    if raw.contains('\0') {
        return None;
    }
    let s = raw.replace('\\', "/");
    if s.starts_with('/') || s.starts_with("//") {
        return None;
    }
    let mut parts = Vec::new();
    for p in s.split('/') {
        match p {
            "" | "." => continue,
            ".." => return None,
            // a drive letter ("C:") or any part with a colon: never a plain relative name
            p if p.len() >= 2 && p.as_bytes()[1] == b':' && parts.is_empty() => return None,
            p => parts.push(p),
        }
    }
    if parts.is_empty() {
        return None;
    }
    let mut key = parts.join("/");
    if is_dir || s.ends_with('/') {
        key.push('/');
    }
    Some(key)
}

/// The folder a key is in ("" for the top).
pub fn parent_of(key: &str) -> &str {
    let t = key.strip_suffix('/').unwrap_or(key);
    match t.rfind('/') {
        Some(i) => &key[..=i],
        None => "",
    }
}

/// Where a file's bytes are.
#[derive(Clone, Copy, Debug)]
pub enum At {
    /// entry number in the zip's central directory
    Zip(usize),
    /// stored as is, at this offset of the (uncompressed) tar file
    Raw(u64),
}

#[derive(Clone, Debug)]
pub struct Item {
    pub key: String,
    pub size: u64,
    /// milliseconds since 1970
    pub modified: Option<i64>,
    pub crc: Option<u32>,
    pub at: At,
}

/// Entries the index left out, so the UI can say so.
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    /// names that point outside the archive's folder (`../x`, `/etc/x`)
    pub unsafe_paths: u32,
    /// symbolic and hard links
    pub links: u32,
    /// password-protected zip entries
    pub encrypted: u32,
    /// devices, pipes, sparse files, compression methods other than deflate
    pub other: u32,
}

/// A file opened for reading at any offset, cheap to clone: every clone has its own position and
/// they can all read at once (the zip reader clones one per file it unpacks).
#[derive(Clone)]
pub struct PosFile {
    f: Arc<File>,
    pos: u64,
    len: u64,
}

impl PosFile {
    pub fn open(path: &Path) -> io::Result<Self> {
        let f = File::open(path)?;
        let len = f.metadata()?.len();
        Ok(Self { f: Arc::new(f), pos: 0, len })
    }
    pub fn len(&self) -> u64 {
        self.len
    }
    fn read_at(&self, buf: &mut [u8], at: u64) -> io::Result<usize> {
        #[cfg(unix)]
        {
            std::os::unix::fs::FileExt::read_at(&*self.f, buf, at)
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::FileExt::seek_read(&*self.f, buf, at)
        }
    }
}

impl Read for PosFile {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.read_at(buf, self.pos)?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for PosFile {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let next = match to {
            SeekFrom::Start(n) => Some(n),
            SeekFrom::End(d) => self.len.checked_add_signed(d),
            SeekFrom::Current(d) => self.pos.checked_add_signed(d),
        };
        self.pos = next.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "seek before the start"))?;
        Ok(self.pos)
    }
}

/// An archive's table of contents.
pub struct Index {
    pub format: Format,
    /// the archive as it was opened
    pub source: PathBuf,
    /// where reads come from: the archive, or for .tar.gz its unpacked .tar
    pub file: PosFile,
    /// the path of `file`
    pub data: PathBuf,
    /// files, by key
    pub items: Vec<Item>,
    by_key: HashMap<String, usize>,
    /// every folder key (ending with `/`), also those only implied by the files in them
    pub dirs: BTreeSet<String>,
    /// folder ("" for the top) → (subfolder keys, file positions in `items`), sorted by key
    children: HashMap<String, (Vec<String>, Vec<usize>)>,
    pub skipped: Skipped,
    /// unpacked bytes of every file
    pub total: u64,
    zip: Option<zip::ZipArchive<PosFile>>,
}

fn bad(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.into())
}

/// Milliseconds since 1970 of a zip time (local time as written, taken as UTC: zips store no zone).
fn zip_millis(t: zip::DateTime) -> Option<i64> {
    let (y, m, d) = (t.year() as i64, t.month() as i64, t.day() as i64);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // days from civil (Howard Hinnant)
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + t.hour() as i64) * 60 + t.minute() as i64) * 60_000 + t.second() as i64 * 1000)
}

impl Index {
    /// Reads the table of contents of `path`. A .tar.gz is unpacked to a .tar in `work` first
    /// (reads need to seek), stopping at the size limits; `cancel` stops that.
    pub fn open(path: &Path, format: Format, work: &Path, cancel: &AtomicBool) -> io::Result<Index> {
        let file = PosFile::open(path)?;
        match format {
            Format::Zip => Self::open_zip(path, file),
            Format::Tar => Self::open_tar(path, file, format),
            Format::TarGz => {
                let tar = gunzip(path, work, file.len(), cancel)?;
                let mut ix = Self::open_tar(path, PosFile::open(&tar)?, format)?;
                ix.data = tar;
                Ok(ix)
            }
        }
    }

    fn open_zip(path: &Path, file: PosFile) -> io::Result<Index> {
        let archive_len = file.len();
        let mut zip = zip::ZipArchive::new(file.clone()).map_err(|e| bad(format!("This isn't a zip archive Kybl can read. {e}")))?;
        if zip.len() > MAX_ENTRIES {
            return Err(bad(format!("This archive holds {} entries, more than Kybl opens.", zip.len())));
        }
        let mut b = Builder::default();
        for i in 0..zip.len() {
            let f = zip.by_index_raw(i).map_err(|e| bad(e.to_string()))?;
            let name = f.name().map(|n| n.into_owned()).unwrap_or_default();
            if f.is_symlink() {
                b.skipped.links += 1;
                continue;
            }
            let dir = f.is_dir();
            let Some(key) = safe_key(&name, dir) else {
                if !name.trim_matches(['/', '.', '\\']).is_empty() {
                    b.skipped.unsafe_paths += 1;
                }
                continue;
            };
            if dir {
                b.dir(key);
                continue;
            }
            if f.encrypted() {
                b.skipped.encrypted += 1;
                continue;
            }
            if !matches!(f.compression(), zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated) {
                b.skipped.other += 1;
                continue;
            }
            b.file(Item { key, size: f.size(), modified: f.last_modified().and_then(zip_millis), crc: Some(f.crc32()), at: At::Zip(i) });
        }
        b.finish(path, file, Format::Zip, Some(zip), archive_len)
    }

    fn open_tar(path: &Path, file: PosFile, format: Format) -> io::Result<Index> {
        let archive_len = std::fs::metadata(path)?.len();
        let mut ar = tar::Archive::new(file.clone());
        let mut b = Builder::default();
        let mut n = 0usize;
        for e in ar.entries_with_seek()? {
            let e = e.map_err(|e| bad(format!("This tar archive is damaged. {e}")))?;
            n += 1;
            if n > MAX_ENTRIES {
                return Err(bad("This archive holds more entries than Kybl opens."));
            }
            let t = e.header().entry_type();
            let name = String::from_utf8_lossy(&e.path_bytes()).into_owned();
            if t.is_symlink() || t.is_hard_link() {
                b.skipped.links += 1;
                continue;
            }
            if t.is_pax_global_extensions() || t.is_pax_local_extensions() || t.is_gnu_longname() || t.is_gnu_longlink() {
                continue;
            }
            let dir = t.is_dir();
            if !dir && !t.is_file() {
                b.skipped.other += 1;
                continue;
            }
            let Some(key) = safe_key(&name, dir) else {
                if !name.trim_matches(['/', '.', '\\']).is_empty() {
                    b.skipped.unsafe_paths += 1;
                }
                continue;
            };
            if dir {
                b.dir(key);
                continue;
            }
            let modified = e.header().mtime().ok().map(|s| s as i64 * 1000);
            b.file(Item { key, size: e.size(), modified, crc: None, at: At::Raw(e.raw_file_position()) });
        }
        b.finish(path, file, format, None, archive_len)
    }

    pub fn item(&self, key: &str) -> Option<&Item> {
        self.by_key.get(key).map(|&i| &self.items[i])
    }

    /// (subfolder keys, files) directly in folder `dir` ("" or ending with `/`).
    pub fn list(&self, dir: &str) -> (Vec<String>, Vec<&Item>) {
        match self.children.get(dir) {
            Some((d, f)) => (d.clone(), f.iter().map(|&i| &self.items[i]).collect()),
            None => (vec![], vec![]),
        }
    }

    /// Whether `dir` is a folder of the archive ("" is its top).
    pub fn has_dir(&self, dir: &str) -> bool {
        dir.is_empty() || self.dirs.contains(dir)
    }

    /// Every file at or below `path` (a file key, or a folder ending with `/`; "" for all).
    pub fn files_under<'a>(&'a self, path: &'a str) -> impl Iterator<Item = &'a Item> + 'a {
        self.items.iter().filter(move |i| if path.ends_with('/') || path.is_empty() { i.key.starts_with(path) } else { i.key == path })
    }

    /// The names at the top of the archive.
    pub fn top(&self) -> Vec<String> {
        let (d, f) = self.list("");
        d.into_iter().chain(f.into_iter().map(|i| i.key.clone())).collect()
    }

    /// Reads a whole file, or the bytes `range` of it, handing chunks to `out` (false stops).
    /// Unpacked bytes are checked against the size the archive declares, so a lying entry can't
    /// grow past it; zip entries are also checked against their CRC.
    pub fn read(&self, item: &Item, range: Option<std::ops::Range<u64>>, out: &mut dyn FnMut(&[u8]) -> bool) -> io::Result<()> {
        let ranged = range.is_some();
        let (start, end) = match range {
            Some(r) => (r.start.min(item.size), r.end.min(item.size)),
            None => (0, item.size),
        };
        let mut buf = vec![0u8; 256 * 1024];
        match item.at {
            At::Raw(off) => {
                let mut f = self.file.clone();
                f.seek(SeekFrom::Start(off + start))?;
                let mut left = end - start;
                while left > 0 {
                    let want = left.min(buf.len() as u64) as usize;
                    let n = f.read(&mut buf[..want])?;
                    if n == 0 {
                        return Err(bad("The archive ends early: it is damaged or incomplete."));
                    }
                    left -= n as u64;
                    if !out(&buf[..n]) {
                        return Ok(());
                    }
                }
                Ok(())
            }
            At::Zip(i) => {
                let mut zip = self.zip.clone().ok_or_else(|| bad("not a zip"))?;
                let mut f = zip.by_index(i).map_err(|e| bad(format!("Couldn't unpack “{}”. {e}", item.key)))?;
                let mut pos = 0u64;
                loop {
                    let n = f.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    let (a, b) = (pos, pos + n as u64);
                    pos = b;
                    if pos > item.size {
                        return Err(bad(format!("“{}” unpacks to more than the archive says. It may be damaged or crafted to fill the disk.", item.key)));
                    }
                    // the part of this chunk inside the range
                    let (lo, hi) = (a.max(start), b.min(end));
                    if lo < hi && !out(&buf[(lo - a) as usize..(hi - a) as usize]) {
                        return Ok(());
                    }
                    // a range that ends early doesn't need the rest (nor the CRC check)
                    if ranged && pos >= end {
                        return Ok(());
                    }
                }
                Ok(())
            }
        }
    }
}

#[derive(Default)]
struct Builder {
    items: Vec<Item>,
    dirs: BTreeSet<String>,
    skipped: Skipped,
}

impl Builder {
    fn dir(&mut self, key: String) {
        self.dirs.insert(key);
    }
    fn file(&mut self, item: Item) {
        self.items.push(item);
    }
    fn finish(mut self, source: &Path, file: PosFile, format: Format, zip: Option<zip::ZipArchive<PosFile>>, archive_len: u64) -> io::Result<Index> {
        // the last entry of a name wins (zips appended to keep both), and a name that is a
        // folder somewhere can't also be a file
        let mut seen = HashMap::new();
        for (i, it) in self.items.iter().enumerate() {
            seen.insert(it.key.clone(), i);
        }
        let mut items: Vec<Item> = self.items.into_iter().enumerate().filter(|(i, it)| seen.get(&it.key) == Some(i)).map(|(_, it)| it).collect();
        // every folder a file or folder is in
        let mut implied = Vec::new();
        for k in items.iter().map(|i| i.key.as_str()).chain(self.dirs.iter().map(|d| d.as_str())) {
            let mut p = parent_of(k);
            while !p.is_empty() {
                implied.push(p.to_string());
                p = parent_of(p);
            }
        }
        self.dirs.extend(implied);
        let before = items.len();
        items.retain(|i| !self.dirs.contains(&format!("{}/", i.key)));
        self.skipped.other += (before - items.len()) as u32;
        items.sort_by(|a, b| a.key.cmp(&b.key));

        let total = items.iter().try_fold(0u64, |s, i| s.checked_add(i.size)).unwrap_or(u64::MAX);
        if total > MAX_TOTAL || (total > BOMB_FLOOR && total / BOMB_RATIO > archive_len.max(1)) {
            return Err(bad(format!(
                "This archive would unpack to {} from {}, which looks like a decompression bomb. Kybl won't open it.",
                human(total),
                human(archive_len)
            )));
        }

        let by_key = items.iter().enumerate().map(|(i, it)| (it.key.clone(), i)).collect();
        let mut children: HashMap<String, (Vec<String>, Vec<usize>)> = HashMap::new();
        children.entry(String::new()).or_default();
        for d in &self.dirs {
            children.entry(d.clone()).or_default();
            children.entry(parent_of(d).to_string()).or_default().0.push(d.clone());
        }
        for (i, it) in items.iter().enumerate() {
            children.entry(parent_of(&it.key).to_string()).or_default().1.push(i);
        }
        Ok(Index { format, source: source.to_path_buf(), data: source.to_path_buf(), file, items, by_key, dirs: self.dirs, children, skipped: self.skipped, total, zip })
    }
}

pub fn human(n: u64) -> String {
    const U: [&str; 5] = ["bytes", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1000.0 && u < U.len() - 1 {
        v /= 1000.0;
        u += 1;
    }
    if u == 0 { format!("{n} bytes") } else { format!("{v:.1} {}", U[u]) }
}

/// Unpacks a .tar.gz to a .tar in `work` (reused while the archive is unchanged), refusing to
/// write more than the bomb limits allow.
fn gunzip(path: &Path, work: &Path, archive_len: u64, cancel: &AtomicBool) -> io::Result<PathBuf> {
    std::fs::create_dir_all(work)?;
    gunzip_with(path, work, archive_len, free_space(work), cancel)
}

/// [`gunzip`] with the disk's free space given (None: not known).
pub(crate) fn gunzip_with(path: &Path, work: &Path, archive_len: u64, free: Option<u64>, cancel: &AtomicBool) -> io::Result<PathBuf> {
    std::fs::create_dir_all(work)?;
    let meta = std::fs::metadata(path)?;
    let stamp = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
    let id = fnv(&format!("{}|{}|{stamp}", path.display(), meta.len()));
    let out = work.join(format!("{id:016x}.tar"));
    if out.exists() {
        return Ok(out);
    }
    let limit = MAX_TOTAL.min(BOMB_FLOOR.max(archive_len.saturating_mul(BOMB_RATIO)));
    // never more than half the disk's free space: a bomb (or a huge honest archive) must not
    // fill the disk before it is refused
    let room = free.map(|f| f / 2);
    let cap = room.map_or(limit, |r| limit.min(r));
    // a name of its own: two opens of one archive at once never write into each other's file
    let part = part_path(&out);
    let res = (|| {
        let mut dec = flate2::read::MultiGzDecoder::new(io::BufReader::new(File::open(path)?));
        let mut w = io::BufWriter::new(File::create(&part)?);
        let mut buf = vec![0u8; 256 * 1024];
        let mut done = 0u64;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(io::Error::new(io::ErrorKind::Interrupted, crate::storage::CANCELLED));
            }
            let n = dec.read(&mut buf).map_err(|e| bad(format!("This .tar.gz is damaged. {e}")))?;
            if n == 0 {
                break;
            }
            done += n as u64;
            if done > limit {
                return Err(bad(format!("This archive unpacks to more than {} from {}, which looks like a decompression bomb. Kybl won't open it.", human(limit), human(archive_len))));
            }
            if done > cap {
                return Err(bad(format!("This archive unpacks to more than {}, over half the free disk space. Free up space to open it.", human(cap))));
            }
            w.write_all(&buf[..n])?;
        }
        w.flush()?;
        Ok(())
    })();
    match res {
        Ok(()) => {
            std::fs::rename(&part, &out)?;
            Ok(out)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

/// Bytes free for this user on the disk holding `dir`; None when the system doesn't say.
#[cfg(unix)]
pub fn free_space(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    // SAFETY: a valid C string and a zeroed out-struct the call fills in
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    #[allow(clippy::unnecessary_cast)]
    Some((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
}

/// Bytes free for this user on the disk holding `dir`; None when the system doesn't say.
#[cfg(windows)]
pub fn free_space(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDiskFreeSpaceExW(dir: *const u16, avail: *mut u64, total: *mut u64, free: *mut u64) -> i32;
    }
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain([0]).collect();
    let mut avail = 0u64;
    // SAFETY: a NUL-terminated wide string; null for the totals it may leave out
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(avail)
}

#[cfg(not(any(unix, windows)))]
pub fn free_space(_dir: &Path) -> Option<u64> {
    None
}

/// A temporary name next to `out` that no other write of this run uses (`<out>.<n>.part`).
pub fn part_path(out: &Path) -> PathBuf {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let mut name = out.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{n}.part"));
    out.with_file_name(name)
}

pub fn fnv(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}
