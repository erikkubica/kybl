//! Live progress of a running job, and progress read back from jobs.db for the others.

use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};

use super::{
    db::{self, Counts, End},
    types::{JobProgress, JobState, Phase},
};

#[derive(Default)]
pub(super) struct Live {
    pub(super) files_total: AtomicU64,
    pub(super) bytes_total: AtomicU64,
    pub(super) files_done: AtomicU64,
    pub(super) bytes_done: AtomicU64,
    pub(super) files_skipped: AtomicU64,
    pub(super) bytes_skipped: AtomicU64,
    pub(super) files_failed: AtomicU64,
    pub(super) bytes_failed: AtomicU64,
    /// bytes actually sent by finished files (skipped ones aren't), for the rate
    pub(super) moved: AtomicU64,
    pub(super) current: Mutex<BTreeMap<String, Arc<AtomicU64>>>,
    rate: Mutex<Rate>,
}

#[derive(Default)]
struct Rate {
    at: Option<Instant>,
    pub(super) moved: u64,
    bps: f64,
}

impl Live {
    pub(super) fn load(&self, n: &Counts) {
        self.files_total.store(n.files_total, Ordering::Relaxed);
        self.bytes_total.store(n.bytes_total, Ordering::Relaxed);
        self.files_done.store(n.files_done, Ordering::Relaxed);
        self.bytes_done.store(n.bytes_done, Ordering::Relaxed);
        self.files_skipped.store(n.files_skipped, Ordering::Relaxed);
        self.bytes_skipped.store(n.bytes_skipped, Ordering::Relaxed);
        self.files_failed.store(n.files_failed, Ordering::Relaxed);
        self.bytes_failed.store(n.bytes_failed, Ordering::Relaxed);
    }

    pub(super) fn snapshot(&self, id: &str, state: JobState, phase: Phase, error: Option<String>) -> JobProgress {
        let (current, in_flight) = {
            let cur = self.current.lock().unwrap();
            (cur.keys().take(3).cloned().collect::<Vec<_>>(), cur.values().map(|b| b.load(Ordering::Relaxed)).sum::<u64>())
        };
        let total = self.bytes_total.load(Ordering::Relaxed);
        let finished = self.bytes_done.load(Ordering::Relaxed) + self.bytes_skipped.load(Ordering::Relaxed);
        let bytes_done = (finished + in_flight).min(total);
        let moved = self.moved.load(Ordering::Relaxed) + in_flight;
        let bps = {
            let mut r = self.rate.lock().unwrap();
            let now = Instant::now();
            if state != JobState::Running {
                r.bps = 0.0;
                r.at = None;
            } else if let Some(at) = r.at {
                let dt = now.duration_since(at).as_secs_f64();
                if dt >= 0.2 {
                    let inst = moved.saturating_sub(r.moved) as f64 / dt;
                    r.bps = if r.bps == 0.0 { inst } else { r.bps * 0.7 + inst * 0.3 };
                    r.at = Some(now);
                    r.moved = moved;
                }
            } else {
                r.at = Some(now);
                r.moved = moved;
            }
            r.bps
        };
        let left = total.saturating_sub(bytes_done + self.bytes_failed.load(Ordering::Relaxed));
        JobProgress {
            id: id.to_string(),
            state,
            phase,
            files_done: self.files_done.load(Ordering::Relaxed),
            files_total: self.files_total.load(Ordering::Relaxed),
            files_failed: self.files_failed.load(Ordering::Relaxed),
            files_skipped: self.files_skipped.load(Ordering::Relaxed),
            bytes_done,
            bytes_total: total,
            rate_bps: bps as u64,
            eta_secs: (state == JobState::Running && bps >= 1.0 && phase == Phase::Copying).then(|| (left as f64 / bps).ceil() as u64),
            current,
            error,
        }
    }

    pub(super) fn count(&self, item: &db::Item, end: End) {
        let size = item.size.max(0) as u64;
        match end {
            End::Done | End::Copied => {
                self.files_done.fetch_add(1, Ordering::Relaxed);
                self.bytes_done.fetch_add(size, Ordering::Relaxed);
                self.moved.fetch_add(size, Ordering::Relaxed);
            }
            End::Skipped | End::SkippedCopied | End::SkippedUnsure | End::InPlace => {
                self.files_skipped.fetch_add(1, Ordering::Relaxed);
                self.bytes_skipped.fetch_add(size, Ordering::Relaxed);
            }
        }
    }

    /// An item failed. A folder isn't among the files counted until it fails (as `db::counts`).
    pub(super) fn failed(&self, item: &db::Item) {
        if item.is_dir {
            self.files_total.fetch_add(1, Ordering::Relaxed);
        }
        self.files_failed.fetch_add(1, Ordering::Relaxed);
        self.bytes_failed.fetch_add(item.size.max(0) as u64, Ordering::Relaxed);
    }
}


pub(super) fn idle_progress(id: &str, state: JobState, error: Option<String>, n: &Counts) -> JobProgress {
    JobProgress {
        id: id.to_string(),
        state,
        phase: match state {
            JobState::Planning => Phase::Planning,
            s if s.is_finished() => Phase::Finished,
            _ => Phase::Copying,
        },
        files_done: n.files_done,
        files_total: n.files_total,
        files_failed: n.files_failed,
        files_skipped: n.files_skipped,
        bytes_done: n.bytes_done + n.bytes_skipped,
        bytes_total: n.bytes_total,
        rate_bps: 0,
        eta_secs: None,
        current: vec![],
        error,
    }
}

