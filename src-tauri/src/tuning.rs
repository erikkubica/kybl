//! Transfer settings (how many files and parts at once, a bandwidth cap, Wi-Fi only) and the
//! shared bandwidth limiter every upload and download byte goes through.
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

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TransferPrefs {
    /// files transferred at the same time per connection
    pub concurrency: usize,
    /// multipart parts in flight per file
    pub part_concurrency: usize,
    /// total upload + download cap in KiB/s; 0 = unlimited
    pub bandwidth_limit_kbps: u64,
    /// phones: only transfer on Wi-Fi (stored here, enforced by the phone side)
    pub wifi_only: bool,
}

impl Default for TransferPrefs {
    fn default() -> Self {
        Self {
            concurrency: DEFAULT_CONCURRENCY,
            part_concurrency: DEFAULT_PART_CONCURRENCY,
            bandwidth_limit_kbps: 0,
            wifi_only: false,
        }
    }
}

impl TransferPrefs {
    /// Values from an old or hand-edited file pulled back into range.
    pub fn clamped(self) -> Self {
        Self {
            concurrency: self.concurrency.clamp(1, MAX_CONCURRENCY),
            part_concurrency: self.part_concurrency.clamp(1, MAX_CONCURRENCY),
            // 1 TiB/s is "unlimited" for any network this runs on; keeps the maths far from overflow
            bandwidth_limit_kbps: self.bandwidth_limit_kbps.min(1 << 30),
            wifi_only: self.wifi_only,
        }
    }
}

/// A partial update from the settings screen: only the fields it sends change.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransferPrefsPatch {
    concurrency: Option<usize>,
    part_concurrency: Option<usize>,
    bandwidth_limit_kbps: Option<u64>,
    wifi_only: Option<bool>,
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
            p.bandwidth_limit_kbps = v;
        }
        if let Some(v) = self.wifi_only {
            p.wifi_only = v;
        }
        p.clamped()
    }
}

static CONCURRENCY: AtomicUsize = AtomicUsize::new(DEFAULT_CONCURRENCY);
static PART_CONCURRENCY: AtomicUsize = AtomicUsize::new(DEFAULT_PART_CONCURRENCY);
static WIFI_ONLY: AtomicBool = AtomicBool::new(false);

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
        bandwidth_limit_kbps: LIMITER.rate.load(Ordering::Relaxed) / 1024,
        wifi_only: wifi_only(),
    }
}

/// Makes `p` the live settings (new transfers pick them up; queued ones re-check the slot count).
pub fn apply(p: TransferPrefs) {
    let p = p.clamped();
    CONCURRENCY.store(p.concurrency, Ordering::Relaxed);
    PART_CONCURRENCY.store(p.part_concurrency, Ordering::Relaxed);
    WIFI_ONLY.store(p.wifi_only, Ordering::Relaxed);
    LIMITER.set_rate(p.bandwidth_limit_kbps * 1024);
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
    let next = prefs.apply(current());
    crate::prefs::save_transfers(&app, next)?;
    apply(next);
    // transfers waiting for a slot look again: a higher limit lets more of them start now
    state.wake_transfer_slots().await;
    Ok(current())
}

// ---------------------------------------------------------------- bandwidth limiter

/// The one limiter all uploads and downloads share, so the cap is a total, not per file.
pub static LIMITER: Limiter = Limiter::new();

/// A token bucket: bytes may pass while there are tokens; tokens refill at `rate` bytes a second
/// up to a small burst. A transfer that takes more than is there runs the bucket into debt and is
/// told how long to wait, so several transfers at once share the rate instead of racing for it.
pub struct Limiter {
    /// bytes per second; 0 = unlimited
    rate: AtomicU64,
    bucket: Mutex<Option<Bucket>>,
}

struct Bucket {
    tokens: f64,
    at: Instant,
}

/// How much can go out in one burst: a quarter of a second of the rate, but at least one read
/// chunk so a low cap still moves in whole chunks.
fn burst(rate: u64) -> f64 {
    (rate as f64 / 4.0).max(64.0 * 1024.0)
}

impl Limiter {
    pub const fn new() -> Self {
        Self { rate: AtomicU64::new(0), bucket: Mutex::new(None) }
    }

    pub fn set_rate(&self, bytes_per_sec: u64) {
        self.rate.store(bytes_per_sec, Ordering::Relaxed);
        // start the new rate fresh: debt run up under a lower cap shouldn't stall the higher one
        *self.bucket.lock().unwrap() = None;
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

    /// Waits as long as the cap asks after `n` bytes went through.
    pub async fn throttle(&self, n: usize) {
        let wait = self.take(n);
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
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

    #[test]
    fn prefs_are_clamped_and_patched() {
        let p = TransferPrefs { concurrency: 0, part_concurrency: 99, bandwidth_limit_kbps: 5, wifi_only: true }.clamped();
        assert_eq!((p.concurrency, p.part_concurrency), (1, 8));
        let patch: TransferPrefsPatch = serde_json::from_str(r#"{"concurrency":5}"#).unwrap();
        let q = patch.apply(p);
        assert_eq!(q, TransferPrefs { concurrency: 5, ..p });
        // missing fields in a stored file take their defaults
        let s: TransferPrefs = serde_json::from_str(r#"{"wifiOnly":true}"#).unwrap();
        assert_eq!(s, TransferPrefs { wifi_only: true, ..Default::default() });
    }
}
