//! A terminal's output on its way to the page: small chunks gathered into batches, and paused
//! while the page is behind.
//!
//! A shell echoing a key press sends a byte or two; a build log sends thousands of small writes a
//! second. Each batch is one message to the web view, so: the first chunk after a quiet spell goes
//! at once (typing stays immediate), and while output keeps coming it is gathered for up to
//! `window` (about 8 ms) or `max` bytes before it goes.
//!
//! Flow control: the page acknowledges what xterm.js has drawn (`terminal_ack`). Once more than
//! [`HIGH_WATER`] bytes are sent but not acknowledged, the pump stops taking chunks; the bounded
//! queue in front of it fills, the reader stops reading, and the program writing the output waits,
//! as it would on a slow real terminal. Nothing piles up in memory on either side.

use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use tokio::{
    sync::{mpsc, Notify},
    time::Instant,
};

/// Bytes sent to the page and not yet acknowledged before the pump waits.
pub const HIGH_WATER: usize = 512 * 1024;
/// The largest batch.
pub const MAX_BATCH: usize = 64 * 1024;
/// How long output keeps gathering while it streams.
pub const WINDOW: Duration = Duration::from_millis(8);
/// Chunks waiting in front of the pump (each at most one read, 16 KiB).
pub const QUEUE: usize = 32;

/// What the page has yet to acknowledge.
#[derive(Default)]
pub struct Credit {
    unacked: AtomicUsize,
    notify: Notify,
}

impl Credit {
    fn sent(&self, n: usize) {
        self.unacked.fetch_add(n, Ordering::AcqRel);
    }

    /// The page drew `n` more bytes.
    pub fn ack(&self, n: usize) {
        let mut cur = self.unacked.load(Ordering::Acquire);
        while let Err(now) = self.unacked.compare_exchange_weak(cur, cur.saturating_sub(n), Ordering::AcqRel, Ordering::Acquire) {
            cur = now;
        }
        self.notify.notify_waiters();
    }

    /// Returns once fewer than [`HIGH_WATER`] bytes are waiting for the page.
    async fn wait_room(&self) {
        loop {
            let woken = self.notify.notified();
            if self.unacked.load(Ordering::Acquire) < HIGH_WATER {
                return;
            }
            woken.await;
        }
    }
}

/// Moves chunks from `rx` to `sink` in batches until `rx` closes (everything left is sent first).
/// `sink` returns false when the page is gone, which ends the pump early.
pub async fn pump(mut rx: mpsc::Receiver<Vec<u8>>, credit: Arc<Credit>, window: Duration, max: usize, mut sink: impl FnMut(Vec<u8>) -> bool) {
    // long ago: the first output goes at once
    let mut last = Instant::now() - window;
    loop {
        credit.wait_room().await;
        let Some(mut buf) = rx.recv().await else { return };
        let mut closed = false;
        // whatever is already waiting joins at once
        while buf.len() < max {
            match rx.try_recv() {
                Ok(more) => buf.extend_from_slice(&more),
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    closed = true;
                    break;
                }
            }
        }
        // still streaming (the last batch went moments ago): gather a little longer
        let due = last + window;
        while !closed && buf.len() < max && Instant::now() < due {
            match tokio::time::timeout_at(due, rx.recv()).await {
                Ok(Some(more)) => buf.extend_from_slice(&more),
                Ok(None) => closed = true,
                Err(_) => break,
            }
        }
        credit.sent(buf.len());
        last = Instant::now();
        if !sink(buf) || closed {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn collect() -> (Arc<Mutex<Vec<Vec<u8>>>>, impl FnMut(Vec<u8>) -> bool) {
        let got = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        (got, move |b| {
            g.lock().unwrap().push(b);
            true
        })
    }

    #[tokio::test]
    async fn chunks_waiting_together_go_as_one_batch() {
        let (tx, rx) = mpsc::channel(QUEUE);
        for c in [b"ab".to_vec(), b"cd".to_vec(), b"ef".to_vec()] {
            tx.send(c).await.unwrap();
        }
        drop(tx);
        let (got, sink) = collect();
        pump(rx, Arc::default(), WINDOW, MAX_BATCH, sink).await;
        assert_eq!(*got.lock().unwrap(), vec![b"abcdef".to_vec()]);
    }

    #[tokio::test]
    async fn a_lone_chunk_goes_at_once_and_a_stream_is_gathered() {
        let (tx, rx) = mpsc::channel(QUEUE);
        let (got, sink) = collect();
        let credit = Arc::new(Credit::default());
        let task = tokio::spawn(pump(rx, credit, Duration::from_millis(40), MAX_BATCH, sink));
        tx.send(b"$ ".to_vec()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(10)).await;
        // the first chunk after a quiet spell didn't wait for the window
        assert_eq!(*got.lock().unwrap(), vec![b"$ ".to_vec()]);
        // right after it, a burst: gathered into the next batch
        for _ in 0..5 {
            tx.send(b"x".to_vec()).await.unwrap();
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        drop(tx);
        task.await.unwrap();
        assert_eq!(*got.lock().unwrap(), vec![b"$ ".to_vec(), b"xxxxx".to_vec()]);
    }

    #[tokio::test]
    async fn batches_stop_at_the_size_limit() {
        let (tx, rx) = mpsc::channel(QUEUE);
        for _ in 0..4 {
            tx.send(vec![7u8; 10]).await.unwrap();
        }
        drop(tx);
        let (got, sink) = collect();
        pump(rx, Arc::default(), WINDOW, 20, sink).await;
        let sizes: Vec<usize> = got.lock().unwrap().iter().map(Vec::len).collect();
        assert_eq!(sizes, vec![20, 20]);
    }

    #[tokio::test]
    async fn waits_while_the_page_is_behind_and_goes_on_after_an_ack() {
        let (tx, rx) = mpsc::channel(QUEUE);
        let (got, sink) = collect();
        let credit = Arc::new(Credit::default());
        let task = tokio::spawn(pump(rx, credit.clone(), WINDOW, HIGH_WATER, sink));
        tx.send(vec![0u8; HIGH_WATER]).await.unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        tx.send(b"more".to_vec()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        // nothing acknowledged yet: "more" waits
        assert_eq!(got.lock().unwrap().len(), 1);
        credit.ack(HIGH_WATER);
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(got.lock().unwrap().last().unwrap(), b"more");
        drop(tx);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn stops_when_the_page_is_gone() {
        let (tx, rx) = mpsc::channel(QUEUE);
        tx.send(b"a".to_vec()).await.unwrap();
        let mut calls = 0;
        pump(rx, Arc::default(), WINDOW, MAX_BATCH, |_| {
            calls += 1;
            false
        })
        .await;
        assert_eq!(calls, 1);
        drop(tx);
    }
}
