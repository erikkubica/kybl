//! A small in-process S3 server for tests: objects, ranged reads, ListObjectsV2 (with
//! delimiter), DeleteObjects and the whole multipart API (create, UploadPart, ListParts,
//! complete, abort). It checks `Content-MD5` on every body that carries one, the way a real
//! server refuses a damaged upload, and it can be told to fail an upload's part to test resuming.
//! Signatures aren't checked. (rclone's S3 server can't be used for multipart: the SDK rejects its
//! replies.)

use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
};

use base64::Engine;
use md5::{Digest, Md5};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

/// (bytes, ETag)
type Blob = (Vec<u8>, String);

#[derive(Default)]
pub struct State {
    pub objects: BTreeMap<String, Blob>,
    /// upload id → (key, part number → part)
    pub uploads: HashMap<String, (String, BTreeMap<i32, Blob>)>,
    next_upload: u64,
    /// UploadPart requests received (with their part numbers)
    pub parts_received: Vec<i32>,
    /// refused for a wrong Content-MD5
    pub bad_digests: u32,
    /// object and part uploads that came without a Content-MD5
    pub without_md5: u32,
    /// fail the UploadPart with this part number (once per upload)
    pub fail_part: Option<i32>,
    failed_once: Vec<String>,
}

pub struct Mock {
    pub endpoint: String,
    pub state: Arc<Mutex<State>>,
}

fn hex(d: &[u8]) -> String {
    d.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned()
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn tags<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find(&open) {
        let after = &rest[i + open.len()..];
        let Some(j) = after.find(&close) else { break };
        out.push(&after[..j]);
        rest = &after[j + close.len()..];
    }
    out
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn reply(status: u16, body: impl Into<Vec<u8>>) -> Reply {
    Reply { status, headers: vec![], body: body.into() }
}

fn error(status: u16, code: &str) -> Reply {
    reply(status, format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Error><Code>{code}</Code><Message>{code}</Message></Error>"))
}

pub async fn start() -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let state = Arc::new(Mutex::new(State::default()));
    let st = state.clone();
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else { return };
            let st = st.clone();
            tokio::spawn(async move {
                let (r, mut w) = sock.into_split();
                let mut r = BufReader::new(r);
                loop {
                    let mut line = String::new();
                    if r.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let mut parts = line.split_whitespace();
                    let (method, target) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
                    let mut headers = HashMap::new();
                    loop {
                        let mut h = String::new();
                        if r.read_line(&mut h).await.unwrap_or(0) == 0 {
                            return;
                        }
                        let h = h.trim_end();
                        if h.is_empty() {
                            break;
                        }
                        if let Some((k, v)) = h.split_once(':') {
                            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
                        }
                    }
                    let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
                    let mut body = vec![0u8; len];
                    if r.read_exact(&mut body).await.is_err() {
                        return;
                    }
                    let rep = handle(&st, &method, &target, &headers, body);
                    // HEAD says how long the body would be, and sends none
                    let mut out = format!("HTTP/1.1 {} X\r\nContent-Length: {}\r\n", rep.status, rep.body.len());
                    for (k, v) in &rep.headers {
                        out.push_str(&format!("{k}: {v}\r\n"));
                    }
                    out.push_str("\r\n");
                    if w.write_all(out.as_bytes()).await.is_err() {
                        return;
                    }
                    if method != "HEAD" && w.write_all(&rep.body).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    Mock { endpoint, state }
}

fn handle(st: &Mutex<State>, method: &str, target: &str, headers: &HashMap<String, String>, body: Vec<u8>) -> Reply {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let q: HashMap<String, String> = query
        .split('&')
        .filter(|s| !s.is_empty())
        .map(|kv| match kv.split_once('=') {
            Some((k, v)) => (decode(k), decode(v)),
            None => (decode(kv), String::new()),
        })
        .collect();
    let path = decode(path.trim_start_matches('/'));
    let (bucket, key) = path.split_once('/').unwrap_or((&path, ""));
    let _ = bucket;
    let mut s = st.lock().unwrap();

    if method == "PUT" && !body.is_empty() && !headers.contains_key("content-md5") {
        s.without_md5 += 1;
    }
    // every body that says its MD5 must match it
    if let Some(m) = headers.get("content-md5")
        && base64::engine::general_purpose::STANDARD.encode(Md5::digest(&body)) != *m
    {
        s.bad_digests += 1;
        return error(400, "BadDigest");
    }
    let etag = || hex(&Md5::digest(&body));
    match method {
        "POST" if q.contains_key("uploads") => {
            s.next_upload += 1;
            let id = format!("up{}", s.next_upload);
            s.uploads.insert(id.clone(), (key.to_string(), BTreeMap::new()));
            reply(
                200,
                format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><InitiateMultipartUploadResult><Bucket>b</Bucket><Key>{}</Key><UploadId>{id}</UploadId></InitiateMultipartUploadResult>", esc(key)),
            )
        }
        "PUT" if q.contains_key("uploadId") => {
            let id = q["uploadId"].clone();
            let n: i32 = q.get("partNumber").and_then(|v| v.parse().ok()).unwrap_or(0);
            s.parts_received.push(n);
            if s.fail_part == Some(n) && !s.failed_once.contains(&id) {
                s.failed_once.push(id);
                return error(500, "InternalError");
            }
            let tag = etag();
            let Some(up) = s.uploads.get_mut(&id) else { return error(404, "NoSuchUpload") };
            up.1.insert(n, (body, tag.clone()));
            Reply { status: 200, headers: vec![("ETag".into(), format!("\"{tag}\""))], body: vec![] }
        }
        "GET" if q.contains_key("uploadId") => {
            let Some(up) = s.uploads.get(&q["uploadId"]) else { return error(404, "NoSuchUpload") };
            let parts: String = up
                .1
                .iter()
                .map(|(n, (b, t))| format!("<Part><PartNumber>{n}</PartNumber><ETag>\"{t}\"</ETag><Size>{}</Size></Part>", b.len()))
                .collect();
            reply(200, format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListPartsResult><Bucket>b</Bucket><Key>{}</Key><UploadId>{}</UploadId><IsTruncated>false</IsTruncated>{parts}</ListPartsResult>", esc(key), q["uploadId"]))
        }
        "POST" if q.contains_key("uploadId") => {
            let Some((k, parts)) = s.uploads.remove(&q["uploadId"]) else { return error(404, "NoSuchUpload") };
            let xml = String::from_utf8_lossy(&body);
            let mut data = Vec::new();
            let mut md5s = Md5::new();
            let wanted = tags(&xml, "PartNumber");
            for n in &wanted {
                let Some((b, t)) = parts.get(&n.parse::<i32>().unwrap_or(-1)) else { return error(400, "InvalidPart") };
                data.extend_from_slice(b);
                md5s.update((0..t.len()).step_by(2).map(|i| u8::from_str_radix(&t[i..i + 2], 16).unwrap()).collect::<Vec<_>>());
            }
            let tag = format!("{}-{}", hex(&md5s.finalize()), wanted.len());
            s.objects.insert(k.clone(), (data, tag.clone()));
            reply(200, format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><CompleteMultipartUploadResult><Bucket>b</Bucket><Key>{}</Key><ETag>\"{tag}\"</ETag></CompleteMultipartUploadResult>", esc(&k)))
        }
        "DELETE" if q.contains_key("uploadId") => {
            s.uploads.remove(&q["uploadId"]);
            reply(204, vec![])
        }
        "POST" if q.contains_key("delete") => {
            let xml = String::from_utf8_lossy(&body).into_owned();
            let mut done = String::new();
            for k in tags(&xml, "Key") {
                s.objects.remove(k);
                done.push_str(&format!("<Deleted><Key>{k}</Key></Deleted>"));
            }
            reply(200, format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><DeleteResult>{done}</DeleteResult>"))
        }
        "PUT" => {
            let tag = etag();
            s.objects.insert(key.to_string(), (body, tag.clone()));
            Reply { status: 200, headers: vec![("ETag".into(), format!("\"{tag}\""))], body: vec![] }
        }
        "DELETE" => {
            s.objects.remove(key);
            reply(204, vec![])
        }
        "GET" | "HEAD" if key.is_empty() => {
            // ListObjectsV2, one page
            let prefix = q.get("prefix").cloned().unwrap_or_default();
            let delim = q.get("delimiter").cloned().filter(|d| !d.is_empty());
            let max: usize = q.get("max-keys").and_then(|m| m.parse().ok()).unwrap_or(1000);
            let mut contents = String::new();
            let mut prefixes = std::collections::BTreeSet::new();
            let mut n = 0;
            for (k, (b, t)) in s.objects.range(prefix.clone()..) {
                if !k.starts_with(&prefix) || n >= max {
                    break;
                }
                let rest = &k[prefix.len()..];
                if let Some(d) = &delim
                    && let Some(i) = rest.find(d.as_str())
                {
                    prefixes.insert(format!("{prefix}{}", &rest[..i + d.len()]));
                    continue;
                }
                n += 1;
                contents.push_str(&format!(
                    "<Contents><Key>{}</Key><LastModified>2026-11-22T10:00:00.000Z</LastModified><ETag>\"{t}\"</ETag><Size>{}</Size><StorageClass>STANDARD</StorageClass></Contents>",
                    esc(k),
                    b.len()
                ));
            }
            let cps: String = prefixes.iter().map(|p| format!("<CommonPrefixes><Prefix>{}</Prefix></CommonPrefixes>", esc(p))).collect();
            reply(
                200,
                format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>b</Name><Prefix>{}</Prefix><KeyCount>{}</KeyCount><MaxKeys>{max}</MaxKeys><IsTruncated>false</IsTruncated>{contents}{cps}</ListBucketResult>",
                    esc(&prefix),
                    n + prefixes.len()
                ),
            )
        }
        "GET" | "HEAD" => {
            let Some((data, tag)) = s.objects.get(key) else { return error(404, "NoSuchKey") };
            let mut out = vec![
                ("ETag".to_string(), format!("\"{tag}\"")),
                ("Last-Modified".to_string(), "Sun, 22 Nov 2026 10:00:00 GMT".to_string()),
                ("Content-Type".to_string(), "application/octet-stream".to_string()),
            ];
            // "bytes=a-b" or "bytes=a-"
            let range = headers.get("range").and_then(|r| r.strip_prefix("bytes=")).and_then(|r| {
                let (a, b) = r.split_once('-')?;
                let a: usize = a.parse().ok()?;
                let b: usize = if b.is_empty() { data.len().saturating_sub(1) } else { b.parse::<usize>().ok()?.min(data.len().saturating_sub(1)) };
                (a < data.len() && a <= b).then_some((a, b))
            });
            match range {
                Some((a, b)) => {
                    out.push(("Content-Range".into(), format!("bytes {a}-{b}/{}", data.len())));
                    Reply { status: 206, headers: out, body: data[a..=b].to_vec() }
                }
                None => Reply { status: 200, headers: out, body: data.clone() },
            }
        }
        _ => error(400, "NotImplemented"),
    }
}
