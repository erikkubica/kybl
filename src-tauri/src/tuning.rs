//! Transfer settings (how many files and parts at once, download and upload caps, Wi-Fi only,
//! checking files after they arrive) and the shared bandwidth limiters every upload and download
//! byte goes through.
//!
//! The settings live in `app.json` next to the other app preferences (see `prefs`) and are kept in
//! atomics here, so a transfer reads the current value when it starts without a lock.

use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State};

use crate::state::AppState;

pub const DEFAULT_CONCURRENCY: usize = 3;
pub const DEFAULT_PART_CONCURRENCY: usize = 4;
const MAX_CONCURRENCY: usize = 8;

/// What is checked once a file has been uploaded or downloaded.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum VerifyMode {
    #[default]
    Off,
    /// the sizes on both sides match
    Size,
    /// sizes, and a content hash where both sides can give one cheaply (see `verify`)
    Checksum,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TransferPrefs {
    /// files transferred at the same time per connection
    pub concurrency: usize,
    /// multipart parts in flight per file
    pub part_concurrency: usize,
    /// download cap in KiB/s (all downloads together); 0 = unlimited
    pub download_limit_kbps: u64,
    /// upload cap in KiB/s (all uploads together); 0 = unlimited
    pub upload_limit_kbps: u64,
    /// the one cap for both directions older versions kept: read once into both, never written
    #[serde(skip_serializing)]
    pub bandwidth_limit_kbps: u64,
    /// phones: only transfer on Wi-Fi (stored here, enforced by the phone side)
    pub wifi_only: bool,
    /// checked after each uploaded or downloaded file
    pub verify: VerifyMode,
}

impl Default for TransferPrefs {
    fn default() -> Self {
        Self {
            concurrency: DEFAULT_CONCURRENCY,
            part_concurrency: DEFAULT_PART_CONCURRENCY,
            download_limit_kbps: 0,
            upload_limit_kbps: 0,
            bandwidth_limit_kbps: 0,
            wifi_only: false,
            verify: VerifyMode::Off,
        }
    }
}

/// 1 TiB/s is "unlimited" for any network this runs on; keeps the maths far from overflow.
const MAX_LIMIT_KBPS: u64 = 1 << 30;

impl TransferPrefs {
    /// Values from an old or hand-edited file pulled back into range.
    pub fn clamped(self) -> Self {
        let (mut down, mut up) = (self.download_limit_kbps, self.upload_limit_kbps);
        // an old file's shared cap becomes the cap of each direction
        if self.bandwidth_limit_kbps > 0 && down == 0 && up == 0 {
            (down, up) = (self.bandwidth_limit_kbps, self.bandwidth_limit_kbps);
        }
        Self {
            concurrency: self.concurrency.clamp(1, MAX_CONCURRENCY),
            part_concurrency: self.part_concurrency.clamp(1, MAX_CONCURRENCY),
            download_limit_kbps: down.min(MAX_LIMIT_KBPS),
            upload_limit_kbps: up.min(MAX_LIMIT_KBPS),
            bandwidth_limit_kbps: 0,
            wifi_only: self.wifi_only,
            verify: self.verify,
        }
    }
}

/// A partial update from the settings screen: only the fields it sends change.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransferPrefsPatch {
    concurrency: Option<usize>,
    part_concurrency: Option<usize>,
    download_limit_kbps: Option<u64>,
    upload_limit_kbps: Option<u64>,
    /// both directions at once (older screens)
    bandwidth_limit_kbps: Option<u64>,
    wifi_only: Option<bool>,
    verify: Option<VerifyMode>,
}

impl TransferPrefsPatch {
    fn apply(self, mut p: TransferPrefs) -> TransferPrefs {
        if let Some(v) = self.concurrency {
            p.concurrency = v;
        }
        if let Some(v) = self.part_concurrency {
            p.part_concurrency = v;
        }
        if let Some(v) = self.bandwidth_limit_kbps {
            p.download_limit_kbps = v;
            p.upload_limit_kbps = v;
        }
        if let Some(v) = self.download_limit_kbps {
            p.download_limit_kbps = v;
        }
        if let Some(v) = self.upload_limit_kbps {
            p.upload_limit_kbps = v;
        }
        if let Some(v) = self.wifi_only {
            p.wifi_only = v;
        }
        if let Some(v) = self.verify {
            p.verify = v;
        }
        p.clamped()
    }
}

static CONCURRENCY: AtomicUsize = AtomicUsize::new(DEFAULT_CONCURRENCY);
static PART_CONCURRENCY: AtomicUsize = AtomicUsize::new(DEFAULT_PART_CONCURRENCY);
static WIFI_ONLY: AtomicBool = AtomicBool::new(false);
/// [`VerifyMode`] as a number: 0 off, 1 size, 2 checksum
static VERIFY: AtomicUsize = AtomicUsize::new(0);

/// Files at the same time per connection.
pub fn concurrency() -> usize {
    CONCURRENCY.load(Ordering::Relaxed)
}

/// Parts in flight per multipart upload.
pub fn part_concurrency() -> usize {
    PART_CONCURRENCY.load(Ordering::Relaxed)
}

/// Whether transfers should wait for Wi-Fi (only phones ever see a metered network).
pub fn wifi_only() -> bool {
    WIFI_ONLY.load(Ordering::Relaxed)
}

/// What to check after each uploaded or downloaded file.
pub fn verify_mode() -> VerifyMode {
    match VERIFY.load(Ordering::Relaxed) {
        1 => VerifyMode::Size,
        2 => VerifyMode::Checksum,
        _ => VerifyMode::Off,
    }
}

/// How often (in bytes) a download checks that "Wi-Fi only" doesn't want it to pause.
pub const WIFI_CHECK_BYTES: u64 = 8 * 1024 * 1024;

/// "Wi-Fi only" is on and the phone is on mobile data (or a metered Wi-Fi) right now.
pub fn hold_for_wifi() -> bool {
    wifi_only() && crate::platform::on_metered_network()
}

/// Waits while [`hold_for_wifi`] (or until `cancel`). False when cancelled.
pub async fn wait_for_wifi(cancel: &AtomicBool) -> bool {
    while hold_for_wifi() && !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    !cancel.load(Ordering::Relaxed)
}

pub fn current() -> TransferPrefs {
    TransferPrefs {
        concurrency: concurrency(),
        part_concurrency: part_concurrency(),
        download_limit_kbps: DOWN.rate() / 1024,
        upload_limit_kbps: UP.rate() / 1024,
        bandwidth_limit_kbps: 0,
        wifi_only: wifi_only(),
        verify: verify_mode(),
    }
}

/// Makes `p` the live settings (new transfers pick them up; queued ones re-check the slot count;
/// a new cap applies to running transfers at once).
pub fn apply(p: TransferPrefs) {
    let p = p.clamped();
    CONCURRENCY.store(p.concurrency, Ordering::Relaxed);
    PART_CONCURRENCY.store(p.part_concurrency, Ordering::Relaxed);
    WIFI_ONLY.store(p.wifi_only, Ordering::Relaxed);
    VERIFY.store(
        match p.verify {
            VerifyMode::Off => 0,
            VerifyMode::Size => 1,
            VerifyMode::Checksum => 2,
        },
        Ordering::Relaxed,
    );
    DOWN.set_rate(p.download_limit_kbps * 1024);
    UP.set_rate(p.upload_limit_kbps * 1024);
}

#[tauri::command]
pub fn get_transfer_prefs() -> TransferPrefs {
    current()
}

#[tauri::command]
pub async fn set_transfer_prefs<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    prefs: TransferPrefsPatch,
) -> Result<TransferPrefs, String> {
    // held from reading the settings to making them live: two changes at once (the speed menu
    // and a Settings toggle) each build on the other's result instead of the same old one
    static CHANGING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    {
        let _one = CHANGING.lock().await;
        let next = prefs.apply(current());
        crate::prefs::save_transfers(&app, next)?;
        apply(next);
    }
    // transfers waiting for a slot look again: a higher limit lets more of them start now
    state.wake_transfer_slots().await;
    Ok(current())
}

// ---------------------------------------------------------------- bandwidth limiters

/// All downloads share this cap (bytes coming in from a server), so it is a total, not per file.
pub static DOWN: Limiter = Limiter::new();
/// All uploads share this cap (bytes going out to a server).
pub static UP: Limiter = Limiter::new();

/// A token bucket: bytes may pass while there are tokens; tokens refill at `rate` bytes a second
/// up to a small burst. A transfer that takes more than is there runs the bucket into debt and is
/// told how long to wait, so several transfers at once queue up for the rate instead of racing
/// for it. Waits are taken in equal quanta ([`Limiter::throttle`]), so a transfer reading big
/// chunks gets no bigger share than one reading small ones.
///
/// Every byte stream of every backend goes through [`DOWN`] or [`UP`]: the S3 bodies
/// (`multipart`, `s3_stream`, `transfers`), the server backends' write loop (`net::Meter`), the
/// cloud drives' upload source (`extras::Source`), and downloads and copies between connections
/// (`generic_cmds::download`, `jobs::copy`). This device's own disk never is.
pub struct Limiter {
    /// bytes per second; 0 = unlimited
    rate: AtomicU64,
    /// bumped by every change of rate, so transfers already waiting under the old one stop
    generation: AtomicU64,
    bucket: Mutex<Option<Bucket>>,
}

struct Bucket {
    tokens: f64,
    at: Instant,
}

/// A wait a request body polls by hand ([`Limiter::take_wait`]).
pub type Wait = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + Sync>>;

/// How much can go out in one burst: a quarter of a second of the rate, but at least one read
/// chunk so a low cap still moves in whole chunks.
fn burst(rate: u64) -> f64 {
    (rate as f64 / 4.0).max(64.0 * 1024.0)
}

/// The share a transfer waits for at a time: 64 KiB, or 20 ms of the rate on fast lines (so a
/// sleep never gets shorter than the timer can keep).
fn quantum(rate: u64) -> usize {
    ((rate / 50) as usize).max(64 * 1024)
}

impl Limiter {
    pub const fn new() -> Self {
        Self { rate: AtomicU64::new(0), generation: AtomicU64::new(0), bucket: Mutex::new(None) }
    }

    pub fn rate(&self) -> u64 {
        self.rate.load(Ordering::Relaxed)
    }

    pub fn set_rate(&self, bytes_per_sec: u64) {
        if self.rate.swap(bytes_per_sec, Ordering::Relaxed) == bytes_per_sec {
            return;
        }
        // start the new rate fresh: debt run up under a lower cap shouldn't stall the higher one,
        // and transfers asleep under the old rate wake up to the new one
        *self.bucket.lock().unwrap() = None;
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    /// Takes `n` bytes' worth of tokens; returns how long to wait before sending more.
    pub fn take(&self, n: usize) -> Duration {
        self.take_at(n, Instant::now())
    }

    fn take_at(&self, n: usize, now: Instant) -> Duration {
        let rate = self.rate.load(Ordering::Relaxed);
        if rate == 0 {
            return Duration::ZERO;
        }
        let cap = burst(rate);
        let mut guard = self.bucket.lock().unwrap();
        let b = guard.get_or_insert(Bucket { tokens: cap, at: now });
        let elapsed = now.saturating_duration_since(b.at).as_secs_f64();
        b.tokens = (b.tokens + elapsed * rate as f64).min(cap);
        b.at = now;
        b.tokens -= n as f64;
        if b.tokens >= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(-b.tokens / rate as f64)
        }
    }

    /// Sleeps `wait`, cut short when the rate changes meanwhile (the new rate applies at once).
    pub async fn pause(&self, wait: Duration) {
        self.pause_unless(wait, None).await;
    }

    /// [`pause`](Self::pause), also cut short when `stop` is set (Pause or Cancel of the
    /// transfer waiting): at a low cap one wait can last minutes, and the row must not sit in it.
    pub async fn pause_unless(&self, wait: Duration, stop: Option<&AtomicBool>) {
        if wait.is_zero() {
            return;
        }
        let generation = self.generation.load(Ordering::Relaxed);
        let until = tokio::time::Instant::now() + wait;
        loop {
            let now = tokio::time::Instant::now();
            if now >= until || self.generation.load(Ordering::Relaxed) != generation || stop.is_some_and(|s| s.load(Ordering::Relaxed)) {
                return;
            }
            tokio::time::sleep((until - now).min(Duration::from_millis(100))).await;
        }
    }

    /// Waits as long as the cap asks after `n` bytes went through, a quantum at a time; the wait
    /// ends as soon as `stop` is set.
    pub async fn throttle_unless(&self, mut n: usize, stop: Option<&AtomicBool>) {
        while n > 0 {
            let rate = self.rate();
            if rate == 0 {
                return;
            }
            let q = n.min(quantum(rate));
            n -= q;
            self.pause_unless(self.take(q), stop).await;
            if stop.is_some_and(|s| s.load(Ordering::Relaxed)) {
                return;
            }
        }
    }

    /// Takes `n` bytes' worth and gives the wait that asks for, for request bodies that poll it
    /// by hand (their frames are a quantum or less); None when there is nothing to wait for.
    pub fn take_wait(&'static self, n: usize) -> Option<Wait> {
        let d = self.take(n);
        (!d.is_zero()).then(|| Box::pin(self.pause(d)) as Wait)
    }

    /// One transfer's way through the limiter (see [`Lane`]).
    pub fn lane(&'static self) -> Lane {
        Lane { limiter: self, owed: 0 }
    }
}

/// One stream's share of a [`Limiter`]: bytes are owed until they make up a whole quantum, then
/// waited for a quantum at a time. Every stream thus queues for the rate in equal steps, however
/// small or large the chunks its backend hands over, so concurrent transfers get equal shares.
pub struct Lane {
    limiter: &'static Limiter,
    owed: usize,
}

impl Lane {
    /// After `n` more bytes went through; the wait ends as soon as `stop` is set.
    pub async fn throttle_unless(&mut self, n: usize, stop: Option<&AtomicBool>) {
        let rate = self.limiter.rate();
        if rate == 0 {
            self.owed = 0;
            return;
        }
        self.owed += n;
        let q = quantum(rate);
        while self.owed >= q {
            self.owed -= q;
            self.limiter.pause_unless(self.limiter.take(q), stop).await;
            if self.limiter.rate() == 0 || stop.is_some_and(|s| s.load(Ordering::Relaxed)) {
                self.owed = 0;
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlimited_never_waits() {
        let l = Limiter::new();
        assert_eq!(l.take(10 << 20), Duration::ZERO);
    }

    #[test]
    fn the_cap_holds_over_time() {
        let l = Limiter::new();
        l.set_rate(1024 * 1024); // 1 MiB/s, burst 256 KiB
        let t0 = Instant::now();
        // the burst goes straight through
        assert_eq!(l.take_at(256 * 1024, t0), Duration::ZERO);
        // the next MiB has to wait a full second for its tokens
        let w = l.take_at(1024 * 1024, t0);
        assert!((w.as_secs_f64() - 1.0).abs() < 0.01, "{w:?}");
        // a second later the debt is paid; the next chunk waits only for itself
        let w = l.take_at(512 * 1024, t0 + Duration::from_secs(1));
        assert!((w.as_secs_f64() - 0.5).abs() < 0.01, "{w:?}");
    }

    #[test]
    fn idle_time_refills_only_up_to_the_burst() {
        let l = Limiter::new();
        l.set_rate(100 * 1024);
        let t0 = Instant::now();
        let _ = l.take_at(64 * 1024, t0);
        // an hour idle still only buys one burst (64 KiB minimum here), not an hour's worth
        let later = t0 + Duration::from_secs(3600);
        assert_eq!(l.take_at(64 * 1024, later), Duration::ZERO);
        assert!(l.take_at(100 * 1024, later) > Duration::from_millis(900));
    }

    /// Streams sharing one limiter in simulated time, each sending chunks of its own size through
    /// a [`Lane`] (owed bytes waited for a quantum at a time): bytes each one moved in `secs`.
    fn simulate(l: &Limiter, chunks: &[usize], secs: f64) -> Vec<u64> {
        let t0 = Instant::now();
        let q = quantum(l.rate());
        let mut ready = vec![0f64; chunks.len()];
        let mut moved = vec![0u64; chunks.len()];
        let mut owed = vec![0usize; chunks.len()];
        loop {
            let (i, at) = ready.iter().enumerate().fold((0, f64::MAX), |b, (i, &t)| if t < b.1 { (i, t) } else { b });
            if at >= secs {
                return moved;
            }
            if owed[i] < q {
                // the next chunk goes out, and is owed
                moved[i] += chunks[i] as u64;
                owed[i] += chunks[i];
                continue;
            }
            owed[i] -= q;
            ready[i] = at + l.take_at(q, t0 + Duration::from_secs_f64(at)).as_secs_f64();
        }
    }

    #[test]
    fn the_rate_is_kept_across_many_transfers() {
        let l = Limiter::new();
        l.set_rate(2_000_000);
        let moved: u64 = simulate(&l, &[64 << 10; 6], 30.0).iter().sum();
        // 30 s at 2 MB/s, plus the first burst
        let want = 30.0 * 2_000_000.0 + burst(2_000_000);
        assert!((moved as f64 - want).abs() / want < 0.03, "moved {moved}, want about {want}");
    }

    #[test]
    fn transfers_share_the_rate_fairly_whatever_their_chunk_size() {
        let l = Limiter::new();
        l.set_rate(1_000_000);
        // a backend reading 16 KiB at a time next to one handing over 1 MiB chunks
        let moved = simulate(&l, &[16 << 10, 1 << 20, 64 << 10], 60.0);
        let (min, max) = (*moved.iter().min().unwrap() as f64, *moved.iter().max().unwrap() as f64);
        assert!(max / min < 1.1, "shares {moved:?}");
    }

    #[test]
    fn a_new_rate_applies_at_once() {
        tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(async {
            static L: Limiter = Limiter::new();
            L.set_rate(64 * 1024);
            // run deep into debt: about 10 s of waiting at this rate
            let wait = L.take(64 * 1024 * 11);
            assert!(wait > Duration::from_secs(9));
            let start = tokio::time::Instant::now();
            let sleeper = tokio::spawn(L.pause(wait));
            tokio::time::sleep(Duration::from_millis(300)).await;
            // the user lifts the cap: the waiting transfer goes on right away
            L.set_rate(0);
            sleeper.await.unwrap();
            assert!(start.elapsed() < Duration::from_secs(1), "{:?}", start.elapsed());
            assert_eq!(L.take(10 << 20), Duration::ZERO);
            // and a lower cap starts fresh rather than inheriting old debt
            L.set_rate(1_000_000);
            assert_eq!(L.take(200_000), Duration::ZERO);
        });
    }

    #[test]
    fn prefs_are_clamped_and_patched() {
        let p = TransferPrefs { concurrency: 0, part_concurrency: 99, wifi_only: true, ..Default::default() }.clamped();
        assert_eq!((p.concurrency, p.part_concurrency), (1, 8));
        let patch: TransferPrefsPatch = serde_json::from_str(r#"{"concurrency":5}"#).unwrap();
        let q = patch.apply(p);
        assert_eq!(q, TransferPrefs { concurrency: 5, ..p });
        // missing fields in a stored file take their defaults
        let s: TransferPrefs = serde_json::from_str(r#"{"wifiOnly":true}"#).unwrap();
        assert_eq!(s, TransferPrefs { wifi_only: true, ..Default::default() });
        // directions and checks
        let patch: TransferPrefsPatch = serde_json::from_str(r#"{"downloadLimitKbps":512,"verify":"checksum"}"#).unwrap();
        let r = patch.apply(q);
        assert_eq!((r.download_limit_kbps, r.upload_limit_kbps, r.verify), (512, 0, VerifyMode::Checksum));
    }

    #[test]
    fn an_old_shared_cap_becomes_both_directions() {
        let old: TransferPrefs = serde_json::from_str(r#"{"bandwidthLimitKbps":2048}"#).unwrap();
        let p = old.clamped();
        assert_eq!((p.download_limit_kbps, p.upload_limit_kbps), (2048, 2048));
        let saved = serde_json::to_value(p).unwrap();
        assert!(saved.get("bandwidthLimitKbps").is_none(), "{saved}");
        // older screens sending the one cap set both
        let patch: TransferPrefsPatch = serde_json::from_str(r#"{"bandwidthLimitKbps":100}"#).unwrap();
        let q = patch.apply(TransferPrefs::default());
        assert_eq!((q.download_limit_kbps, q.upload_limit_kbps), (100, 100));
    }
}
