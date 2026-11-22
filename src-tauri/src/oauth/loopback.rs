//! The loopback address the browser comes back to after signing in (computers, and Google and
//! Dropbox on phones).
//!
//! - Some redirects say `localhost`, which the browser may look up as 127.0.0.1 or as [::1], so
//!   Kybl listens on both, on the same port (IPv4 only where the device has no IPv6 loopback).
//! - Connections are served side by side. Browsers often open a spare connection and never send
//!   anything on it; that one must not hold up the connection carrying the code.
//! - Each connection gets a few seconds in all to send its request, however slowly it trickles.
//!
//! The `state` check is the same as ever: only the request carrying our `state` ends the wait.

use std::{
    io,
    net::{Ipv4Addr, Ipv6Addr},
    time::Duration,
};

use futures_util::{stream::FuturesUnordered, StreamExt};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
};

use crate::kybl_connect as kc;

/// How long one connection may take to send its whole request head.
const HEAD_DEADLINE: Duration = Duration::from_secs(10);
/// Connections served at once; more wait to be accepted until one is done.
const MAX_CONNS: usize = 32;

/// Listening on 127.0.0.1 and, where there is one, [::1], on one port.
#[derive(Debug)]
pub struct Loopback {
    v4: TcpListener,
    v6: Option<TcpListener>,
}

impl Loopback {
    pub fn port(&self) -> io::Result<u16> {
        Ok(self.v4.local_addr()?.port())
    }

    #[cfg(test)]
    pub fn has_v6(&self) -> bool {
        self.v6.is_some()
    }
}

/// [::1] on `port`. Ok(None): this device has no IPv6 loopback. Err: another app has the port
/// there (the browser could end up talking to it).
async fn bind_v6(port: u16) -> io::Result<Option<TcpListener>> {
    match TcpListener::bind((Ipv6Addr::LOCALHOST, port)).await {
        Ok(l) => Ok(Some(l)),
        Err(e) if e.kind() == io::ErrorKind::AddrInUse => Err(e),
        Err(_) => Ok(None),
    }
}

/// Binds the loopback listener: any free port, or the first of `ports` free on both addresses.
pub async fn listen(ports: &[u16]) -> Result<Loopback, String> {
    let failed = |e: &dyn std::fmt::Display| format!("Couldn't start the sign-in listener: {e}");
    if ports.is_empty() {
        // the free IPv4 port may be taken on [::1] by another app: pick another one then
        let mut last = None;
        for _ in 0..8 {
            let v4 = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.map_err(|e| failed(&e))?;
            let port = v4.local_addr().map_err(|e| failed(&e))?.port();
            match bind_v6(port).await {
                Ok(v6) => return Ok(Loopback { v4, v6 }),
                Err(e) => last = Some(e),
            }
        }
        return Err(failed(&last.map(|e| e.to_string()).unwrap_or_default()));
    }
    for p in ports {
        let Ok(v4) = TcpListener::bind((Ipv4Addr::LOCALHOST, *p)).await else { continue };
        if let Ok(v6) = bind_v6(*p).await {
            return Ok(Loopback { v4, v6 });
        }
    }
    let list: Vec<String> = ports.iter().map(u16::to_string).collect();
    Err(format!("The sign-in needs port {} on this device, and another app is using it. Close that app and try again.", list.join(" or ")))
}

/// What the browser sees once the code arrived: a page (computers) or a redirect back into the
/// app (phones, where the tab must close).
#[derive(Clone, Copy)]
pub enum Reply<'a> {
    #[cfg_attr(mobile, allow(dead_code))]
    Page(&'a str),
    #[cfg_attr(desktop, allow(dead_code))]
    Redirect(&'a str),
}

/// Waits for the browser to come back with a code for our `state`. Stray requests (a favicon, a
/// wrong or replayed state, a connection that never says anything) get an error or are dropped,
/// and the wait goes on.
pub async fn wait(lb: &Loopback, state: &str, reply: Reply<'_>) -> Result<String, String> {
    wait_with(lb, state, reply, HEAD_DEADLINE).await
}

async fn accept(l: Option<&TcpListener>) -> io::Result<TcpStream> {
    match l {
        Some(l) => l.accept().await.map(|(s, _)| s),
        None => std::future::pending().await,
    }
}

async fn wait_with(lb: &Loopback, state: &str, reply: Reply<'_>, deadline: Duration) -> Result<String, String> {
    let mut conns = FuturesUnordered::new();
    loop {
        let room = conns.len() < MAX_CONNS;
        let accepted = tokio::select! {
            r = accept(Some(&lb.v4)), if room => r,
            r = accept(lb.v6.as_ref()), if room => r,
            Some(done) = conns.next() => match done {
                Some(r) => return r,
                None => continue,
            },
        };
        match accepted {
            Ok(s) => conns.push(serve(s, state, reply, deadline)),
            // out of file handles or a connection reset before it was accepted: try again shortly
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}

/// One connection. Some(result) when it carried our `state`; None for anything else.
async fn serve(mut stream: TcpStream, state: &str, reply: Reply<'_>, deadline: Duration) -> Option<Result<String, String>> {
    // `read_target` limits each read and the head's size; this limits the whole head
    let target = tokio::time::timeout(deadline, kc::read_target(&mut stream)).await.ok().flatten()?;
    if target.split('?').next() != Some("/callback") {
        kc::respond(&mut stream, "404 Not Found", "").await;
        return None;
    }
    let q = kc::query(&target);
    if q.get("state").map(String::as_str) != Some(state) {
        kc::respond(&mut stream, "400 Bad Request", &kc::page("This sign-in link doesn't belong to the Kybl window that's waiting. Start again from the app.")).await;
        return None;
    }
    let r = kc::code_from_redirect(&q, state);
    match reply {
        Reply::Page(ok) => {
            let msg = if r.is_ok() { ok } else { "The sign-in was cancelled. You can close this tab." };
            kc::respond(&mut stream, "200 OK", &kc::page(msg)).await;
        }
        Reply::Redirect(to) => {
            let res = format!("HTTP/1.1 302 Found\r\nlocation: {to}\r\ncontent-length: 0\r\ncache-control: no-store\r\nconnection: close\r\n\r\n");
            let _ = stream.write_all(res.as_bytes()).await;
            let _ = stream.shutdown().await;
        }
    }
    Some(r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;
    use std::time::Instant;
    use tokio::net::TcpStream;

    /// Sends one request and reads the whole answer.
    async fn ask(addr: (&'static str, u16), req: &'static [u8]) -> String {
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(req).await.unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out).await;
        out
    }

    #[tokio::test]
    async fn loopback_redirects_phones_back_into_the_app() {
        let lb = listen(&[]).await.unwrap();
        let port = lb.port().unwrap();
        let client = tokio::spawn(ask(("127.0.0.1", port), b"GET /callback?code=c0de&state=good HTTP/1.1\r\nhost: x\r\n\r\n"));
        assert_eq!(wait(&lb, "good", Reply::Redirect("kybl://oauth/done")).await.unwrap(), "c0de");
        let out = client.await.unwrap();
        assert!(out.starts_with("HTTP/1.1 302"), "{out}");
        assert!(out.contains("location: kybl://oauth/done"));
    }

    #[tokio::test]
    async fn an_idle_connection_doesnt_hold_up_the_callback() {
        let lb = listen(&[]).await.unwrap();
        let port = lb.port().unwrap();
        // a browser's spare connection: opened first, never used
        let _idle = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut half = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        half.write_all(b"GET /callb").await.unwrap();
        let client = tokio::spawn(ask(("127.0.0.1", port), b"GET /callback?code=c0de&state=good HTTP/1.1\r\n\r\n"));
        let r = tokio::time::timeout(Duration::from_secs(3), wait(&lb, "good", Reply::Page("ok"))).await;
        assert_eq!(r.expect("the callback waited for the idle connection").unwrap(), "c0de");
        assert!(client.await.unwrap().starts_with("HTTP/1.1 200"));
    }

    #[tokio::test]
    async fn localhost_over_ipv6_reaches_it_too() {
        // a device without an IPv6 loopback can't run this one
        if TcpListener::bind((Ipv6Addr::LOCALHOST, 0)).await.is_err() {
            return;
        }
        let lb = listen(&[]).await.unwrap();
        assert!(lb.has_v6());
        let port = lb.port().unwrap();
        let client = tokio::spawn(ask(("::1", port), b"GET /callback?code=six&state=good HTTP/1.1\r\n\r\n"));
        assert_eq!(wait(&lb, "good", Reply::Page("ok")).await.unwrap(), "six");
        assert!(client.await.unwrap().starts_with("HTTP/1.1 200"));
    }

    #[tokio::test]
    async fn a_wrong_state_is_refused_and_the_wait_goes_on() {
        let lb = listen(&[]).await.unwrap();
        let port = lb.port().unwrap();
        let waiting = async { wait(&lb, "good", Reply::Page("ok")).await };
        let clients = async {
            let wrong = ask(("127.0.0.1", port), b"GET /callback?code=evil&state=bad HTTP/1.1\r\n\r\n").await;
            let none = ask(("127.0.0.1", port), b"GET /callback?code=evil HTTP/1.1\r\n\r\n").await;
            let other = ask(("127.0.0.1", port), b"GET /favicon.ico HTTP/1.1\r\n\r\n").await;
            let post = ask(("127.0.0.1", port), b"POST /callback?code=evil&state=good HTTP/1.1\r\n\r\n").await;
            let right = ask(("127.0.0.1", port), b"GET /callback?code=c0de&state=good HTTP/1.1\r\n\r\n").await;
            (wrong, none, other, post, right)
        };
        let (got, (wrong, none, other, post, right)) = tokio::join!(waiting, clients);
        assert_eq!(got.unwrap(), "c0de");
        assert!(wrong.starts_with("HTTP/1.1 400"), "{wrong}");
        assert!(none.starts_with("HTTP/1.1 400"), "{none}");
        assert!(other.starts_with("HTTP/1.1 404"), "{other}");
        assert!(post.is_empty(), "only GET counts: {post}");
        assert!(right.starts_with("HTTP/1.1 200"));
    }

    #[tokio::test]
    async fn a_trickling_connection_is_cut_off() {
        let lb = listen(&[]).await.unwrap();
        let port = lb.port().unwrap();
        let drip = tokio::spawn(async move {
            let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let start = Instant::now();
            // one byte at a time, never finishing the head
            while start.elapsed() < Duration::from_secs(5) {
                if s.write_all(b"G").await.is_err() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
                let mut b = [0u8; 1];
                if let Ok(Ok(0)) = tokio::time::timeout(Duration::from_millis(1), s.read(&mut b)).await {
                    break;
                }
            }
            start.elapsed()
        });
        let waiting = wait_with(&lb, "good", Reply::Page("ok"), Duration::from_millis(300));
        let right = async {
            let took = drip.await.unwrap();
            let r = ask(("127.0.0.1", port), b"GET /callback?code=c0de&state=good HTTP/1.1\r\n\r\n").await;
            (took, r)
        };
        let (got, (took, _)) = tokio::join!(waiting, right);
        assert!(took < Duration::from_secs(2), "the slow connection stayed open {took:?}");
        assert_eq!(got.unwrap(), "c0de");
    }

    #[tokio::test]
    async fn fixed_ports_take_the_next_free_one() {
        let a = listen(&[]).await.unwrap();
        let b = listen(&[]).await.unwrap();
        let (pa, pb) = (a.port().unwrap(), b.port().unwrap());
        drop(b);
        let ports: &'static [u16] = Box::leak(vec![pa, pb].into_boxed_slice());
        assert_eq!(listen(ports).await.unwrap().port().unwrap(), pb);
        let only: &'static [u16] = Box::leak(vec![pa].into_boxed_slice());
        assert!(listen(only).await.unwrap_err().contains("another app"));
    }

    #[tokio::test]
    async fn a_port_another_app_holds_on_ipv6_is_skipped() {
        let Ok(other) = TcpListener::bind((Ipv6Addr::LOCALHOST, 0)).await else { return };
        let taken = other.local_addr().unwrap().port();
        // 127.0.0.1 is free on that port, [::1] isn't
        let Ok(_free_v4) = TcpListener::bind((Ipv4Addr::LOCALHOST, taken)).await.map(drop) else { return };
        let next = listen(&[]).await.unwrap();
        let pn = next.port().unwrap();
        drop(next);
        let ports: &'static [u16] = Box::leak(vec![taken, pn].into_boxed_slice());
        assert_eq!(listen(ports).await.unwrap().port().unwrap(), pn);
    }
}
