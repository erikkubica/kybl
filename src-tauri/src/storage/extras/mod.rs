//! What the cloud drives (Google Drive, OneDrive, Dropbox) share: reading an upload source in
//! fixed-size pieces (so big files go up in sessions that can resume), dates as the APIs write
//! them, byte ranges, and turning an HTTP response into a [`ReadStream`].

pub mod hashes;

use std::{
    io::{self, SeekFrom},
    ops::Range,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use super::*;
use crate::tuning::LIMITER;

// ---------------------------------------------------------------- dates

/// Days since 1970-01-01 of a calendar date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// "2024-05-06T07:08:09.123Z" (or with an offset such as "+02:00") as milliseconds since the epoch.
pub fn parse_rfc3339(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, sec) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    let mut rest = &s[19..];
    let mut ms = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits = frac.bytes().take_while(u8::is_ascii_digit).count();
        let f = &frac[..digits];
        ms = format!("{f:0<3}")[..3].parse().ok()?;
        rest = &frac[digits..];
    }
    let offset_min = match rest {
        "" | "Z" | "z" => 0,
        o if o.len() == 6 && (o.starts_with('+') || o.starts_with('-')) => {
            let v = o[1..3].parse::<i64>().ok()? * 60 + o[4..6].parse::<i64>().ok()?;
            if o.starts_with('-') { -v } else { v }
        }
        _ => return None,
    };
    let days = days_from_civil(y, mo, d);
    Some(((days * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60) * 1000) + ms)
}

/// Milliseconds since the epoch as "2024-05-06T07:08:09Z" (what Graph and Dropbox take).
pub fn format_rfc3339(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let t = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", t / 3600, t % 3600 / 60, t % 60)
}

/// An HTTP date ("Wed, 21 Oct 2015 07:28:00 GMT") as milliseconds since the epoch.
pub fn parse_http_date(s: &str) -> Option<i64> {
    let mut it = s.split_whitespace();
    let _weekday = it.next()?;
    let d: i64 = it.next()?.parse().ok()?;
    let mon = it.next()?;
    let m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].iter().position(|x| x.eq_ignore_ascii_case(mon))? as i64 + 1;
    let y: i64 = it.next()?.parse().ok()?;
    let mut hms = it.next()?.split(':').map(|x| x.parse::<i64>().ok());
    let (h, mi, sec) = (hms.next()??, hms.next()??, hms.next()??);
    Some((days_from_civil(y, m, d) * 86_400 + h * 3600 + mi * 60 + sec) * 1000)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ---------------------------------------------------------------- ranges

/// The `Range` header for a byte range (end exclusive); None for an empty range.
pub fn range_header(r: &Range<u64>) -> Option<String> {
    (r.end > r.start).then(|| format!("bytes={}-{}", r.start, r.end - 1))
}

/// "bytes 0-99/1234" as (0..100, Some(1234)); "bytes 0-99/*" has no total; "bytes */1234" is
/// what a 416 sends: an empty range at the end.
pub fn parse_content_range(v: &str) -> Option<(Range<u64>, Option<u64>)> {
    let v = v.trim().strip_prefix("bytes")?.trim();
    let (span, total) = v.split_once('/')?;
    let total = if total.trim() == "*" { None } else { Some(total.trim().parse().ok()?) };
    if span.trim() == "*" {
        let t = total?;
        return Some((t..t, total));
    }
    let (a, b) = span.split_once('-')?;
    let (a, b): (u64, u64) = (a.trim().parse().ok()?, b.trim().parse().ok()?);
    (b >= a).then_some((a..b + 1, total))
}

/// The next byte the server wants, from a resumable-upload status: Drive's `Range: bytes=0-N`
/// (nothing yet when absent) or Graph's `nextExpectedRanges: ["N-"]`.
pub fn received_upto(range_header: Option<&str>) -> u64 {
    range_header
        .and_then(|r| r.trim().strip_prefix("bytes=")?.split_once('-')?.1.trim().parse::<u64>().ok())
        .map(|last| last + 1)
        .unwrap_or(0)
}

/// A download answer as a [`ReadStream`]. `asked` is the range that was requested. `range` says
/// exactly what the body holds: a 206's Content-Range (which may differ from `asked`: callers
/// that need a range check it), or None when the server sent the whole file anyway (200, with
/// `total` its size). A 206 that doesn't say which bytes it holds (no Content-Range, or several
/// ranges in one multipart body) can't be used: its body fails when read.
pub fn read_stream(res: reqwest::Response, asked: Option<&Range<u64>>, etag: Option<String>) -> ReadStream {
    let status = res.status().as_u16();
    let header = |n: &str| res.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
    let len = res.content_length().or_else(|| header("content-length").and_then(|v| v.parse().ok()));
    let content_type = header("content-type");
    let etag = etag.or_else(|| header("etag"));
    let unusable = |say: &'static str, etag, content_type| {
        let body: ByteStream = Box::pin(futures_util::stream::once(async move { Err(io::Error::other(say)) }));
        ReadStream { body, len: None, total: None, range: asked.cloned(), etag, content_type }
    };
    let (range, total) = match (status, header("content-range").and_then(|v| parse_content_range(&v))) {
        (206, Some((r, _))) if len.is_some_and(|l| l != r.end - r.start) => {
            return unusable("The server sent a different amount of the file than it said.", etag, content_type);
        }
        (206 | 416, Some((r, t))) => (Some(r), t),
        (416, None) => (asked.map(|a| a.start..a.start), None),
        (206, None) => return unusable("The server sent part of the file without saying which part.", etag, content_type),
        _ => (None, len),
    };
    let body: ByteStream = if status == 416 {
        Box::pin(futures_util::stream::empty())
    } else {
        Box::pin(res.bytes_stream().map(|r| r.map_err(io::Error::other)))
    };
    let len = if status == 416 { Some(0) } else { len };
    ReadStream { body, len, total, range, etag, content_type }
}

// ---------------------------------------------------------------- upload sources

enum Inner {
    File(tokio::fs::File),
    Bytes(Bytes),
    Stream { body: ByteStream, buf: BytesMut, reopen: Option<Reopen>, ended: bool },
}

/// An upload's bytes, read a piece at a time and from any offset (to resume). The bandwidth cap
/// applies as pieces are read.
pub struct Source {
    inner: Inner,
    /// total size, when known
    pub len: Option<u64>,
    /// the offset of the next byte [`chunk`](Source::chunk) gives
    pub pos: u64,
    /// a temporary copy [`spool`](Source::spool) made; removed with the source
    spooled: Option<PathBuf>,
}

impl Drop for Source {
    fn drop(&mut self) {
        if let Some(p) = self.spooled.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

const READ: usize = 256 * 1024;

impl Source {
    pub async fn open(src: WriteSource) -> SResult<Self> {
        let (inner, len) = match src {
            WriteSource::Path(p) => {
                let f = tokio::fs::File::open(&p).await?;
                let len = f.metadata().await?.len();
                (Inner::File(f), Some(len))
            }
            WriteSource::Bytes(b) => {
                let n = b.len() as u64;
                (Inner::Bytes(b), Some(n))
            }
            WriteSource::Stream { len, body, reopen } => (Inner::Stream { body, buf: BytesMut::new(), reopen, ended: false }, len),
        };
        Ok(Self { inner, len, pos: 0, spooled: None })
    }

    /// The next `n` bytes, fewer only at the end (empty once everything was read). Stops with
    /// Cancelled when `cancel` is set.
    pub async fn chunk(&mut self, n: usize, cancel: &AtomicBool) -> SResult<Bytes> {
        let out = match &mut self.inner {
            Inner::Bytes(b) => {
                let start = (self.pos as usize).min(b.len());
                let end = start.saturating_add(n).min(b.len());
                b.slice(start..end)
            }
            Inner::File(f) => {
                let mut buf = BytesMut::with_capacity(n);
                while buf.len() < n {
                    if cancel.load(Ordering::Relaxed) {
                        return Err(StorageError::cancelled());
                    }
                    let want = (n - buf.len()).min(READ);
                    let start = buf.len();
                    buf.resize(start + want, 0);
                    let got = f.read(&mut buf[start..]).await?;
                    buf.truncate(start + got);
                    if got == 0 {
                        break;
                    }
                    LIMITER.throttle(got).await;
                }
                buf.freeze()
            }
            Inner::Stream { body, buf, ended, .. } => {
                while buf.len() < n && !*ended {
                    if cancel.load(Ordering::Relaxed) {
                        return Err(StorageError::cancelled());
                    }
                    match body.next().await {
                        Some(c) => {
                            let c = c?;
                            LIMITER.throttle(c.len()).await;
                            buf.extend_from_slice(&c);
                        }
                        None => *ended = true,
                    }
                }
                let take = n.min(buf.len());
                buf.split_to(take).freeze()
            }
        };
        if cancel.load(Ordering::Relaxed) {
            return Err(StorageError::cancelled());
        }
        self.pos += out.len() as u64;
        Ok(out)
    }

    /// Everything that is left, refusing more than `max` bytes.
    pub async fn rest(&mut self, max: u64, cancel: &AtomicBool) -> SResult<Bytes> {
        let mut out = BytesMut::new();
        loop {
            let c = self.chunk(4 * 1024 * 1024, cancel).await?;
            if c.is_empty() {
                return Ok(out.freeze());
            }
            out.extend_from_slice(&c);
            if out.len() as u64 > max {
                return Err(StorageError::too_large());
            }
        }
    }

    /// Carries on from byte `to` (a resumed upload, or a piece the server didn't take).
    pub async fn seek(&mut self, to: u64) -> SResult<()> {
        if to == self.pos {
            return Ok(());
        }
        match &mut self.inner {
            Inner::Bytes(_) => {}
            Inner::File(f) => {
                f.seek(SeekFrom::Start(to)).await?;
            }
            Inner::Stream { body, buf, reopen, ended } => {
                if let Some(open) = reopen.as_ref() {
                    *body = open(to).await?;
                    buf.clear();
                    *ended = false;
                } else if to > self.pos {
                    // only forwards: skip what the server already has
                    let mut skip = to - self.pos;
                    self.pos = to;
                    while skip > 0 {
                        let had = buf.len() as u64;
                        if had >= skip {
                            let _ = buf.split_to(skip as usize);
                            break;
                        }
                        buf.clear();
                        skip -= had;
                        match body.next().await {
                            Some(c) => buf.extend_from_slice(&c?),
                            None => return Err(StorageError::other("The file being copied ended early.")),
                        }
                    }
                    return Ok(());
                } else {
                    return Err(StorageError::other("This upload can't go back to an earlier point. Try again."));
                }
            }
        }
        self.pos = to;
        Ok(())
    }

    /// A source of unknown size, copied to a temporary file first, for services that need the
    /// size before an upload starts (OneDrive). Sources of known size are returned as they are.
    pub async fn spool(mut self, cancel: &AtomicBool) -> SResult<Self> {
        if self.len.is_some() {
            return Ok(self);
        }
        let path = std::env::temp_dir().join(format!("kybl-upload-{}", uuid::Uuid::new_v4()));
        let mut out = tokio::fs::File::create(&path).await?;
        let guard = Source { inner: Inner::Bytes(Bytes::new()), len: Some(0), pos: 0, spooled: Some(path.clone()) };
        let mut total = 0u64;
        loop {
            let c = self.chunk(4 * 1024 * 1024, cancel).await?;
            if c.is_empty() {
                break;
            }
            total += c.len() as u64;
            out.write_all(&c).await?;
        }
        out.flush().await?;
        drop(out);
        let f = tokio::fs::File::open(&path).await?;
        let mut s = guard;
        s.inner = Inner::File(f);
        s.len = Some(total);
        Ok(s)
    }
}

/// "photo.jpg" → ("photo", ".jpg"); folders and names without a dot have no extension. A name
/// that only starts with a dot (".env") has none either.
pub fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// The parent folder of a key ("a/b/c.txt" → "a/b/", "a/" → "") and its last name.
pub fn parent_and_name(key: &str) -> (&str, &str) {
    let k = key.trim_end_matches('/');
    match k.rfind('/') {
        Some(i) => (&key[..=i], &k[i + 1..]),
        None => ("", k),
    }
}

/// A key's path components, refusing ones no service accepts.
pub fn components(key: &str) -> SResult<Vec<&str>> {
    let mut out = Vec::new();
    for c in key.split('/') {
        match c {
            "" => continue,
            "." | ".." => return Err(StorageError::other("A file or folder name can't be \".\" or \"..\".")),
            c => out.push(c),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_both_ways() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2015-05-12T15:50:38Z"), Some(1_431_445_838_000));
        assert_eq!(parse_rfc3339("2015-05-12T15:50:38.5Z"), Some(1_431_445_838_500));
        assert_eq!(parse_rfc3339("2015-05-12T15:50:38.123456Z"), Some(1_431_445_838_123));
        assert_eq!(parse_rfc3339("2015-05-12T17:50:38+02:00"), Some(1_431_445_838_000));
        assert_eq!(parse_rfc3339("nonsense"), None);
        assert_eq!(format_rfc3339(1_431_445_838_999), "2015-05-12T15:50:38Z");
        assert_eq!(format_rfc3339(951_782_400_000), "2000-02-29T00:00:00Z");
        assert_eq!(parse_http_date("Wed, 21 Oct 2015 07:28:00 GMT"), parse_rfc3339("2015-10-21T07:28:00Z"));
    }

    #[test]
    fn ranges() {
        assert_eq!(range_header(&(0..100)).unwrap(), "bytes=0-99");
        assert_eq!(range_header(&(5..5)), None);
        assert_eq!(parse_content_range("bytes 0-99/1234"), Some((0..100, Some(1234))));
        assert_eq!(parse_content_range("bytes 100-199/*"), Some((100..200, None)));
        assert_eq!(parse_content_range("bytes */1234"), Some((1234..1234, Some(1234))));
        assert_eq!(parse_content_range("bytes 9-3/10"), None);
        assert_eq!(parse_content_range("items 0-1/2"), None);
        assert_eq!(received_upto(Some("bytes=0-524287")), 524_288);
        assert_eq!(received_upto(None), 0);
    }

    /// `range` says what the body really holds, whatever was asked for; answers that don't say
    /// can't be read (a resumed copy would otherwise splice the wrong bytes in).
    #[tokio::test]
    async fn read_streams_report_the_range_the_server_sent() {
        use crate::oauth::mock::{Mock, Resp};
        let data: Vec<u8> = (0..100u8).collect();
        let mock = Mock::start(move |req| match req.path.as_str() {
            "/exact" => Resp::bytes(206, data[10..20].to_vec()).header("content-range", "bytes 10-19/100"),
            "/other" => Resp::bytes(206, data[0..10].to_vec()).header("content-range", "bytes 0-9/100"),
            "/whole" => Resp::bytes(200, data.clone()),
            "/unsaid" => Resp::bytes(206, data[10..20].to_vec()),
            "/short" => Resp::bytes(206, data[10..15].to_vec()).header("content-range", "bytes 10-19/100"),
            _ => Resp::status(404),
        })
        .await;
        let asked = 10..20;
        let get = |p: &str| {
            let url = format!("{}{p}", mock.base);
            async move { crate::storage::net::http().get(url).header("range", "bytes=10-19").send().await.unwrap() }
        };

        let r = read_stream(get("/exact").await, Some(&asked), None);
        assert_eq!((r.range.clone(), r.total), (Some(10..20), Some(100)));
        assert_eq!(r.collect(1000).await.unwrap(), (10..20u8).collect::<Vec<_>>());

        let r = read_stream(get("/other").await, Some(&asked), None);
        assert_eq!(r.range, Some(0..10), "the range sent, not the one asked for");

        let r = read_stream(get("/whole").await, Some(&asked), None);
        assert_eq!((r.range.clone(), r.total), (None, Some(100)), "the whole file came");

        let r = read_stream(get("/unsaid").await, Some(&asked), None);
        assert!(r.collect(1000).await.is_err(), "a part without its place can't be used");

        let r = read_stream(get("/short").await, Some(&asked), None);
        assert!(r.collect(1000).await.is_err(), "less than the range it claims");
    }

    #[test]
    fn names() {
        assert_eq!(split_ext("photo.jpg"), ("photo", ".jpg"));
        assert_eq!(split_ext("archive.tar.gz"), ("archive.tar", ".gz"));
        assert_eq!(split_ext(".env"), (".env", ""));
        assert_eq!(split_ext("README"), ("README", ""));
        assert_eq!(parent_and_name("a/b/c.txt"), ("a/b/", "c.txt"));
        assert_eq!(parent_and_name("a/b/"), ("a/", "b"));
        assert_eq!(parent_and_name("c.txt"), ("", "c.txt"));
        assert_eq!(components("a//b/").unwrap(), vec!["a", "b"]);
        assert!(components("a/../b").is_err());
    }

    #[tokio::test]
    async fn sources_read_in_pieces_and_seek() {
        let never = AtomicBool::new(false);
        let data: Vec<u8> = (0..1000u32).map(|i| i as u8).collect();
        let mut s = Source::open(WriteSource::Bytes(Bytes::from(data.clone()))).await.unwrap();
        assert_eq!(s.chunk(300, &never).await.unwrap().len(), 300);
        s.seek(900).await.unwrap();
        assert_eq!(&s.chunk(300, &never).await.unwrap()[..], &data[900..]);
        assert!(s.chunk(300, &never).await.unwrap().is_empty());

        // a stream of unknown length, in uneven pieces, skipping forward
        let parts: Vec<io::Result<Bytes>> = data.chunks(77).map(|c| Ok(Bytes::copy_from_slice(c))).collect();
        let src = WriteSource::Stream { len: None, body: Box::pin(futures_util::stream::iter(parts)), reopen: None };
        let mut s = Source::open(src).await.unwrap();
        assert_eq!(&s.chunk(100, &never).await.unwrap()[..], &data[..100]);
        s.seek(250).await.unwrap();
        assert_eq!(&s.chunk(100, &never).await.unwrap()[..], &data[250..350]);
        assert!(s.seek(10).await.is_err(), "can't go back without reopen");

        // spooled to a file, which knows its size
        let parts: Vec<io::Result<Bytes>> = data.chunks(77).map(|c| Ok(Bytes::copy_from_slice(c))).collect();
        let src = WriteSource::Stream { len: None, body: Box::pin(futures_util::stream::iter(parts)), reopen: None };
        let s = Source::open(src).await.unwrap().spool(&never).await.unwrap();
        assert_eq!(s.len, Some(1000));
        let path = s.spooled.clone().unwrap();
        let mut s = s;
        assert_eq!(&s.rest(10_000, &never).await.unwrap()[..], &data[..]);
        drop(s);
        assert!(!path.exists(), "the temporary copy goes with the source");
    }
}
