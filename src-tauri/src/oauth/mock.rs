//! Tests only: a tiny HTTP server on 127.0.0.1 standing in for Google, Microsoft and Dropbox.
//! It runs on its own thread, so handlers may block (to hold a request open) without stalling
//! the code under test.

use std::{
    collections::HashMap,
    convert::Infallible,
    sync::{Arc, Mutex},
};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{server::conn::http1, service::service_fn, Request, Response};
use hyper_util::rt::TokioIo;
use percent_encoding::percent_decode_str;

#[derive(Clone, Debug)]
pub struct Req {
    pub method: String,
    pub path: String,
    pub query: String,
    /// lowercase names
    pub headers: HashMap<String, String>,
    pub body: Bytes,
}

impl Req {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(&name.to_ascii_lowercase()).map(String::as_str)
    }
    /// A query parameter, decoded.
    pub fn q(&self, key: &str) -> Option<String> {
        self.query.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == key).map(|(_, v)| percent_decode_str(&v.replace('+', " ")).decode_utf8_lossy().into_owned())
    }
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or_default()
    }
}

pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn json(status: u16, v: &serde_json::Value) -> Self {
        Self { status, headers: vec![("content-type".into(), "application/json".into())], body: serde_json::to_vec(v).unwrap() }
    }
    pub fn status(status: u16) -> Self {
        Self { status, headers: vec![], body: vec![] }
    }
    pub fn bytes(status: u16, body: impl Into<Vec<u8>>) -> Self {
        Self { status, headers: vec![], body: body.into() }
    }
    pub fn header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.into(), v.into()));
        self
    }
}

pub struct Mock {
    pub base: String,
    pub requests: Arc<Mutex<Vec<Req>>>,
}

impl Mock {
    pub async fn start(handler: impl Fn(&Req) -> Resp + Send + Sync + 'static) -> Mock {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests: Arc<Mutex<Vec<Req>>> = Default::default();
        let log = requests.clone();
        let handler = Arc::new(handler);
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
            rt.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                loop {
                    let Ok((stream, _)) = listener.accept().await else { continue };
                    let (handler, log) = (handler.clone(), log.clone());
                    tokio::spawn(async move {
                        let svc = service_fn(move |req: Request<hyper::body::Incoming>| {
                            let (handler, log) = (handler.clone(), log.clone());
                            async move {
                                let (parts, body) = req.into_parts();
                                let body = body.collect().await.map(|b| b.to_bytes()).unwrap_or_default();
                                let r = Req {
                                    method: parts.method.to_string(),
                                    path: parts.uri.path().to_string(),
                                    query: parts.uri.query().unwrap_or("").to_string(),
                                    headers: parts
                                        .headers
                                        .iter()
                                        .map(|(k, v)| (k.as_str().to_ascii_lowercase(), v.to_str().unwrap_or("").to_string()))
                                        .collect(),
                                    body,
                                };
                                log.lock().unwrap().push(r.clone());
                                let h = handler.clone();
                                let out = tokio::task::spawn_blocking(move || h(&r)).await.unwrap();
                                let mut b = Response::builder().status(out.status);
                                for (k, v) in &out.headers {
                                    b = b.header(k, v);
                                }
                                Ok::<_, Infallible>(b.body(Full::new(Bytes::from(out.body))).unwrap())
                            }
                        });
                        let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), svc).await;
                    });
                }
            });
        });
        Mock { base, requests }
    }

    /// Requests seen so far whose path starts with `prefix`.
    pub fn seen(&self, prefix: &str) -> Vec<Req> {
        self.requests.lock().unwrap().iter().filter(|r| r.path.starts_with(prefix)).cloned().collect()
    }
}
