//! Drive against a local stand-in server: listings with duplicate names over two pages, paths
//! that find the right duplicate, Google Docs exports, resumable uploads (a piece the server only
//! half took, a resumed session), rate limits and a 401 that refreshes the token.

use std::{
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde_json::json;

use super::*;
use crate::oauth::{
    http::{client, Api},
    mock::{Mock, Req, Resp},
    token::{tests::fixed, tests::MemStore, Stored, TokenSource},
};

fn api(tokens: Arc<TokenSource>) -> Api {
    Api { http: client(), tokens, kind: ConnKind::Gdrive, max_wait: Duration::from_millis(5) }
}

fn file(id: &str, name: &str, mime: &str, created: &str) -> Value {
    json!({ "id": id, "name": name, "mimeType": mime, "size": "10", "createdTime": created, "modifiedTime": created, "md5Checksum": format!("md5-{id}"), "parents": ["root"] })
}

fn files(v: Vec<Value>, next: Option<&str>) -> Resp {
    let mut body = json!({ "files": v });
    if let Some(n) = next {
        body["nextPageToken"] = json!(n);
    }
    Resp::json(200, &body)
}

/// The names a query asks for: "name = 'x'" (or several joined with "or").
fn names_in(q: &str) -> Vec<String> {
    q.split("name = '")
        .skip(1)
        .map(|rest| {
            let mut out = String::new();
            let mut chars = rest.chars();
            while let Some(c) = chars.next() {
                match c {
                    '\\' => out.extend(chars.next()),
                    '\'' => break,
                    c => out.push(c),
                }
            }
            out
        })
        .collect()
}

/// Answers name lookups ("'P' in parents and name = 'x' and trashed = false", or
/// "(name = 'x' or name = 'y')") from a fixed list.
fn lookup(req: &Req, all: &[Value]) -> Option<Resp> {
    let names = names_in(&req.q("q")?);
    if names.is_empty() {
        return None;
    }
    Some(files(all.iter().filter(|f| names.iter().any(|n| f["name"] == n.as_str())).cloned().collect(), None))
}

#[tokio::test]
async fn listings_number_duplicates_across_pages_and_paths_find_them() {
    let all = vec![
        file("id1", "a.txt", "text/plain", "2024-01-01T00:00:00Z"),
        file("id2", "a.txt", "text/plain", "2024-01-02T00:00:00Z"),
        file("id3", "a.txt", "text/plain", "2024-01-03T00:00:00Z"),
        file("dir1", "b", api::FOLDER, "2024-01-01T00:00:00Z"),
    ];
    let a2 = all.clone();
    let mock = Mock::start(move |req| {
        if req.path == "/drive/v3/files" {
            let q = req.q("q").unwrap();
            assert_eq!(req.q("supportsAllDrives").as_deref(), Some("true"));
            if q.contains("name = ") {
                return lookup(req, &a2).unwrap();
            }
            assert_eq!(q, "'root' in parents and trashed = false");
            assert_eq!(req.q("orderBy").as_deref(), Some("name,createdTime"));
            assert_eq!(req.q("corpora").as_deref(), Some("user"));
            return match req.q("pageToken").as_deref() {
                None => files(a2[..2].to_vec(), Some("P2")),
                Some("P2") => files(a2[2..].to_vec(), None),
                other => panic!("token {other:?}"),
            };
        }
        if let Some(id) = req.path.strip_prefix("/drive/v3/files/") {
            return Resp::json(200, a2.iter().find(|f| f["id"] == id).unwrap());
        }
        Resp::status(404)
    })
    .await;
    let g = GDrive::with_base(api(fixed("tok")), &mock.base);

    let p1 = g.list(MY_DRIVE, "", None).await.unwrap();
    assert_eq!(p1.objects.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(), vec!["a.txt", "a (2).txt"]);
    let p2 = g.list(MY_DRIVE, "", p1.next_token).await.unwrap();
    assert_eq!(p2.objects.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(), vec!["a (3).txt"]);
    assert_eq!(p2.folders, vec!["b/"]);
    assert_eq!(p2.next_token, None);
    assert_eq!(p2.objects[0].hashes.md5.as_deref(), Some("md5-id3"));

    // from the cache the listing filled
    assert_eq!(g.stat(MY_DRIVE, "a (3).txt").await.unwrap().unwrap().id.as_deref(), Some("id3"));
    // and with nothing cached: the same rule finds the same file
    let fresh = GDrive::with_base(api(fixed("tok")), &mock.base);
    assert_eq!(fresh.stat(MY_DRIVE, "a (2).txt").await.unwrap().unwrap().id.as_deref(), Some("id2"));
    assert_eq!(fresh.stat(MY_DRIVE, "a.txt").await.unwrap().unwrap().id.as_deref(), Some("id1"));
    assert_eq!(fresh.stat(MY_DRIVE, "a (4).txt").await.unwrap(), None);
    assert_eq!(fresh.stat(MY_DRIVE, "b/").await.unwrap().unwrap().id.as_deref(), Some("dir1"));
    assert_eq!(fresh.stat(MY_DRIVE, "b").await.unwrap(), None, "a folder isn't a file");
}

/// A folder with three "a.txt" and a real "a (2).txt": the second "a.txt" must not show as
/// "a (2).txt" too (one of the two would be hidden, and moving "a (2).txt" would copy one file
/// twice and could delete the other).
#[tokio::test]
async fn duplicate_numbers_skip_real_names() {
    let all = vec![
        file("real2", "a (2).txt", "text/plain", "2023-01-01T00:00:00Z"),
        file("id1", "a.txt", "text/plain", "2024-01-01T00:00:00Z"),
        // same time as id2: the id decides, whatever order Drive sends them in
        file("id3", "a.txt", "text/plain", "2024-01-02T00:00:00Z"),
        file("id2", "a.txt", "text/plain", "2024-01-02T00:00:00Z"),
    ];
    let a2 = all.clone();
    let mock = Mock::start(move |req| {
        if req.path == "/drive/v3/files" {
            let q = req.q("q").unwrap();
            if q.contains("name = ") {
                return lookup(req, &a2).unwrap();
            }
            // pages split so the real "a (2).txt" isn't on the page that numbers the copies
            return match req.q("pageToken").as_deref() {
                None => files(a2[..1].to_vec(), Some("P2")),
                Some("P2") => files(a2[1..].to_vec(), None),
                other => panic!("token {other:?}"),
            };
        }
        if let Some(id) = req.path.strip_prefix("/drive/v3/files/") {
            return Resp::json(200, a2.iter().find(|f| f["id"] == id).unwrap());
        }
        Resp::status(404)
    })
    .await;
    let g = GDrive::with_base(api(fixed("tok")), &mock.base);
    let p1 = g.list(MY_DRIVE, "", None).await.unwrap();
    let p2 = g.list(MY_DRIVE, "", p1.next_token).await.unwrap();
    let shown: Vec<(&str, &str)> = p1.objects.iter().chain(&p2.objects).map(|e| (e.key.as_str(), e.id.as_deref().unwrap())).collect();
    assert_eq!(shown, vec![("a (2).txt", "real2"), ("a.txt", "id1"), ("a (3).txt", "id2"), ("a (4).txt", "id3")]);

    // with nothing cached, every shown name leads back to its own file
    let fresh = GDrive::with_base(api(fixed("tok")), &mock.base);
    for (key, id) in shown {
        assert_eq!(fresh.stat(MY_DRIVE, key).await.unwrap().unwrap().id.as_deref(), Some(id), "{key}");
    }
    assert_eq!(fresh.stat(MY_DRIVE, "a (5).txt").await.unwrap(), None);
}

#[tokio::test]
async fn google_docs_read_as_their_exports() {
    let doc = json!({ "id": "doc1", "name": "Plan", "mimeType": "application/vnd.google-apps.document", "version": "3", "parents": ["root"] });
    let d2 = doc.clone();
    let mock = Mock::start(move |req| {
        if req.path == "/drive/v3/files" {
            return lookup(req, std::slice::from_ref(&d2)).unwrap();
        }
        if req.path == "/drive/v3/files/doc1/export" {
            assert!(req.header("range").is_none());
            let mime = req.q("mimeType").unwrap();
            return Resp::bytes(200, format!("exported as {mime}")).header("content-type", &mime);
        }
        Resp::status(404)
    })
    .await;
    let g = GDrive::with_base(api(fixed("tok")), &mock.base);
    let body = g.read(MY_DRIVE, "Plan", None, None).await.unwrap().collect(1000).await.unwrap();
    assert_eq!(String::from_utf8(body).unwrap(), "exported as application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    let r = g.read(MY_DRIVE, "Plan.pdf", Some(0..10), None).await.unwrap();
    assert_eq!(r.range, None, "exports come whole");
    assert_eq!(String::from_utf8(r.collect(1000).await.unwrap()).unwrap(), "exported as application/pdf");
    let e = g.stat(MY_DRIVE, "Plan").await.unwrap().unwrap();
    assert_eq!(e.native.unwrap().exports[0].ext, "docx");
    assert_eq!(e.etag.as_deref(), Some("v3"));
    assert_eq!(g.stat(MY_DRIVE, "Plan.pdf").await.unwrap().unwrap().mime.as_deref(), Some("application/pdf"));
    assert!(g.stat(MY_DRIVE, "Plan.xyz").await.unwrap().is_none());
    // can't be overwritten
    let cancel = Arc::new(AtomicBool::new(false));
    let r = g.write(MY_DRIVE, "Plan", WriteSource::Bytes("x".into()), WriteOpts::default(), &|_, _| {}, &cancel).await;
    assert_eq!(r.err().unwrap().kind, ErrKind::PermissionDenied);
}

#[tokio::test]
async fn ranges_and_rate_limits() {
    let data: Vec<u8> = (0..100u8).collect();
    let limited = Arc::new(AtomicU32::new(0));
    let l2 = limited.clone();
    let f = file("f1", "x.bin", "application/octet-stream", "2024-01-01T00:00:00Z");
    let mock = Mock::start(move |req| {
        if req.path == "/drive/v3/files" {
            // the first lookup is told to slow down, Drive style
            if l2.fetch_add(1, Ordering::SeqCst) == 0 {
                return Resp::json(403, &json!({ "error": { "code": 403, "errors": [{ "reason": "userRateLimitExceeded" }] } }));
            }
            return lookup(req, std::slice::from_ref(&f)).unwrap();
        }
        if req.path == "/drive/v3/files/f1" && req.q("alt").as_deref() == Some("media") {
            let r = req.header("range").unwrap();
            assert_eq!(r, "bytes=10-19");
            return Resp::bytes(206, data[10..20].to_vec()).header("content-range", "bytes 10-19/100");
        }
        Resp::status(404)
    })
    .await;
    let g = GDrive::with_base(api(fixed("tok")), &mock.base);
    let r = g.read(MY_DRIVE, "x.bin", Some(10..20), None).await.unwrap();
    assert_eq!((r.range.clone(), r.total), (Some(10..20), Some(100)));
    assert_eq!(r.collect(100).await.unwrap(), (10..20u8).collect::<Vec<_>>());
    assert!(limited.load(Ordering::SeqCst) >= 2, "retried after the rate limit");
    // a changed file is refused
    assert_eq!(g.read(MY_DRIVE, "x.bin", None, Some("other")).await.err().unwrap().kind, ErrKind::Conflict);
}

/// A Drive that takes resumable uploads; the second piece is only half taken once.
struct Uploads {
    base: Mutex<String>,
    got: Mutex<Vec<u8>>,
    halved: AtomicU32,
    puts: Mutex<Vec<String>>,
}

fn upload_server(u: Arc<Uploads>, req: &Req) -> Resp {
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/drive/v3/files") => files(vec![], None),
        // the folder "up"
        ("POST", "/drive/v3/files") => {
            let v = req.json();
            assert_eq!(v["mimeType"], api::FOLDER);
            assert_eq!(v["parents"][0], "root");
            Resp::json(200, &json!({ "id": "F1", "name": v["name"], "mimeType": api::FOLDER, "parents": ["root"] }))
        }
        ("POST", "/upload/drive/v3/files") => {
            assert_eq!(req.q("uploadType").as_deref(), Some("resumable"));
            assert_eq!(req.json()["parents"][0], "F1");
            assert_eq!(req.header("x-upload-content-length"), Some("614400"));
            Resp::status(200).header("location", &format!("{}/upload/session1", u.base.lock().unwrap()))
        }
        ("PUT", "/upload/session1") => {
            let range = req.header("content-range").unwrap().to_string();
            u.puts.lock().unwrap().push(range.clone());
            if let Some(total) = range.strip_prefix("bytes */") {
                let have = u.got.lock().unwrap().len();
                let _ = total;
                return if have == 0 { Resp::status(308) } else { Resp::status(308).header("range", &format!("bytes=0-{}", have - 1)) };
            }
            let (span, total) = range.strip_prefix("bytes ").unwrap().split_once('/').unwrap();
            let start: usize = span.split('-').next().unwrap().parse().unwrap();
            let mut got = u.got.lock().unwrap();
            assert_eq!(start, got.len(), "pieces arrive in order: {range}");
            let mut body = req.body.to_vec();
            if start > 0 && u.halved.fetch_add(1, Ordering::SeqCst) == 0 {
                body.truncate(body.len() / 2);
            }
            got.extend_from_slice(&body);
            if got.len().to_string() == total {
                return Resp::json(200, &json!({ "id": "new1", "name": "big.bin", "mimeType": "application/octet-stream", "size": total, "md5Checksum": "m", "parents": ["F1"] }));
            }
            Resp::status(308).header("range", &format!("bytes=0-{}", got.len() - 1))
        }
        _ => Resp::status(404),
    }
}

#[tokio::test]
async fn resumable_uploads_resend_what_the_server_missed() {
    let u = Arc::new(Uploads { base: Default::default(), got: Default::default(), halved: AtomicU32::new(0), puts: Default::default() });
    let u2 = u.clone();
    let mock = Mock::start(move |req| upload_server(u2.clone(), req)).await;
    *u.base.lock().unwrap() = mock.base.clone();
    let g = GDrive::with_base(api(fixed("tok")), &mock.base);

    let data: Vec<u8> = (0..600 * 1024u32).map(|i| (i % 253) as u8).collect();
    let parts = Mutex::new(Vec::new());
    let on_part = |p: PartRecord| parts.lock().unwrap().push(p);
    let last = Mutex::new((0u64, 0u64));
    let opts = WriteOpts { part_size: Some(256 * 1024), on_part: Some(&on_part), ..Default::default() };
    let cancel = Arc::new(AtomicBool::new(false));
    let out = g.write(MY_DRIVE, "up/big.bin", WriteSource::Bytes(data.clone().into()), opts, &|d, t| *last.lock().unwrap() = (d, t), &cancel).await.unwrap();
    let WriteOutcome::Done(e) = out else { panic!("not done") };
    assert_eq!((e.key.as_str(), e.id.as_deref(), e.size), ("up/big.bin", Some("new1"), 614_400));
    assert_eq!(*u.got.lock().unwrap(), data, "every byte, once, in order");
    assert_eq!(*last.lock().unwrap(), (614_400, 614_400));
    let puts = u.puts.lock().unwrap().clone();
    // 0-256K, 256K-512K (only half taken), then on from what arrived
    assert_eq!(puts.len(), 3, "{puts:?}");
    assert_eq!(puts[0], "bytes 0-262143/614400");
    assert_eq!(puts[1], "bytes 262144-524287/614400");
    assert_eq!(puts[2], "bytes 393216-614399/614400", "carries on from what arrived");
    let parts = parts.into_inner().unwrap();
    assert!(parts.iter().all(|p| p.etag.ends_with("/upload/session1")), "the session address, for resuming");
    assert_eq!(parts.iter().map(|p| p.size).sum::<u64>(), 393_216);
}

#[tokio::test]
async fn an_interrupted_upload_resumes_its_session() {
    let u = Arc::new(Uploads { base: Default::default(), got: Default::default(), halved: AtomicU32::new(1), puts: Default::default() });
    let data: Vec<u8> = (0..600 * 1024u32).map(|i| (i % 251) as u8).collect();
    // the session already has the first 256 KiB from an earlier run
    u.got.lock().unwrap().extend_from_slice(&data[..256 * 1024]);
    let u2 = u.clone();
    let mock = Mock::start(move |req| upload_server(u2.clone(), req)).await;
    *u.base.lock().unwrap() = mock.base.clone();
    let g = GDrive::with_base(api(fixed("tok")), &mock.base);
    let resume = ResumeState { upload_id: format!("{}/upload/session1", mock.base), part_size: 256 * 1024, parts: vec![] };
    let opts = WriteOpts { part_size: Some(256 * 1024), resume: Some(resume), ..Default::default() };
    let cancel = Arc::new(AtomicBool::new(false));
    let out = g.write(MY_DRIVE, "up/big.bin", WriteSource::Bytes(data.clone().into()), opts, &|_, _| {}, &cancel).await.unwrap();
    assert!(matches!(out, WriteOutcome::Done(_)));
    assert_eq!(*u.got.lock().unwrap(), data);
    let puts = u.puts.lock().unwrap().clone();
    assert_eq!(puts[0], "bytes */614400", "asks the session how far it got");
    assert_eq!(puts[1], "bytes 262144-524287/614400");
    assert!(mock.seen("/upload/drive/v3/files").is_empty(), "no new session");
}

#[tokio::test]
async fn small_files_go_up_in_one_request_and_a_401_refreshes_the_token() {
    let refreshed = Arc::new(AtomicU32::new(0));
    let r2 = refreshed.clone();
    let mock = Mock::start(move |req| {
        let auth = req.header("authorization").unwrap_or_default().to_string();
        match (req.method.as_str(), req.path.as_str()) {
            ("POST", "/token") => {
                r2.fetch_add(1, Ordering::SeqCst);
                Resp::json(200, &json!({ "access_token": "fresh", "expires_in": 3600 }))
            }
            _ if auth != "Bearer fresh" => Resp::json(401, &json!({ "error": { "code": 401, "message": "Invalid Credentials" } })),
            ("GET", "/drive/v3/files") => files(vec![], None),
            ("POST", "/upload/drive/v3/files") => {
                assert_eq!(req.q("uploadType").as_deref(), Some("multipart"));
                let ct = req.header("content-type").unwrap().to_string();
                let boundary = ct.split("boundary=").nth(1).unwrap();
                let body = String::from_utf8_lossy(&req.body).to_string();
                assert!(body.starts_with(&format!("--{boundary}\r\n")));
                assert!(body.contains(r#""name":"note.txt""#), "{body}");
                assert!(body.contains("\r\n\r\nhello\r\n"), "{body}");
                Resp::json(200, &json!({ "id": "n1", "name": "note.txt", "mimeType": "text/plain", "size": "5", "parents": ["root"] }))
            }
            _ => Resp::status(404),
        }
    })
    .await;
    let store = Arc::new(MemStore(Mutex::new(Some(Stored { refresh_token: "rt".into(), client_id: "c".into(), client_secret: None })), AtomicU32::new(0)));
    let ts = Arc::new(TokenSource::new("p", ConnKind::Gdrive, format!("{}/token", mock.base), |_, _| None, store, Box::new(|_| {})));
    ts.prime("stale", Duration::from_secs(3600)).await;
    let g = GDrive::with_base(api(ts), &mock.base);
    let cancel = Arc::new(AtomicBool::new(false));
    let out = g.write(MY_DRIVE, "note.txt", WriteSource::Bytes("hello".into()), WriteOpts::default(), &|_, _| {}, &cancel).await.unwrap();
    let WriteOutcome::Done(e) = out else { panic!() };
    assert_eq!(e.id.as_deref(), Some("n1"));
    assert_eq!(refreshed.load(Ordering::SeqCst), 1, "one refresh, then everything goes through");
}

#[tokio::test]
async fn roots_are_my_drive_shared_drives_and_shared_with_me() {
    let mock = Mock::start(|req| match req.path.as_str() {
        "/drive/v3/drives" => Resp::json(200, &json!({ "drives": [{ "id": "0AX", "name": "Team", "capabilities": { "canAddChildren": true } }] })),
        "/drive/v3/about" => Resp::json(200, &json!({ "storageQuota": { "usage": "1000", "limit": "15000" } })),
        _ => Resp::status(404),
    })
    .await;
    let g = GDrive::with_base(api(fixed("tok")), &mock.base);
    let roots = g.roots().await.unwrap();
    assert_eq!(roots.iter().map(|r| (r.id.as_str(), r.read_only)).collect::<Vec<_>>(), vec![("root", false), ("0AX", false), (SHARED, true)]);
    let q = g.quota().await.unwrap().unwrap();
    assert_eq!((q.used, q.total), (1000, Some(15000)));
    let cancel = Arc::new(AtomicBool::new(false));
    let e = g.write(SHARED, "x.txt", WriteSource::Bytes("x".into()), WriteOpts::default(), &|_, _| {}, &cancel).await.err().unwrap();
    assert_eq!(e.kind, ErrKind::PermissionDenied);
}

/// A Drive that answers name lookups regardless of case (as Drive's `name =` may), lists the
/// top of My Drive, and knows the real id of My Drive ("0Real").
async fn drive_with(all: Vec<Value>) -> Mock {
    Mock::start(move |req| {
        if req.path == "/drive/v3/files" {
            let q = req.q("q").unwrap();
            if q.contains("name = ") {
                let names: Vec<String> = names_in(&q).iter().map(|n| n.to_lowercase()).collect();
                return files(all.iter().filter(|f| names.iter().any(|n| f["name"].as_str().unwrap().to_lowercase() == *n)).cloned().collect(), None);
            }
            return files(all.clone(), None);
        }
        if req.path == "/drive/v3/files/root" && req.method == "GET" {
            return Resp::json(200, &json!({ "id": "0Real" }));
        }
        if let Some(id) = req.path.strip_prefix("/drive/v3/files/") {
            if let Some(f) = all.iter().find(|f| f["id"] == id) {
                return Resp::json(200, f);
            }
        }
        Resp::status(404)
    })
    .await
}

#[tokio::test]
async fn lookups_only_take_the_exact_name() {
    let mock = drive_with(vec![file("old", "Report.txt", "text/plain", "2023-01-01T00:00:00Z"), file("new", "report.txt", "text/plain", "2024-01-01T00:00:00Z")]).await;
    let g = GDrive::with_base(api(fixed("tok")), &mock.base);
    assert_eq!(g.stat(MY_DRIVE, "report.txt").await.unwrap().unwrap().id.as_deref(), Some("new"));
    assert_eq!(g.stat(MY_DRIVE, "Report.txt").await.unwrap().unwrap().id.as_deref(), Some("old"));
    assert_eq!(g.stat(MY_DRIVE, "REPORT.txt").await.unwrap(), None);
}

#[tokio::test]
async fn a_big_duplicate_number_asks_drive_little() {
    let mock = drive_with(vec![file("a1", "x.txt", "text/plain", "2023-01-01T00:00:00Z"), file("a2", "x.txt", "text/plain", "2024-01-01T00:00:00Z")]).await;
    let g = GDrive::with_base(api(fixed("tok")), &mock.base);
    assert_eq!(g.stat(MY_DRIVE, "x (4000000000).txt").await.unwrap(), None);
    let asked = mock.seen("/drive/v3/files").len();
    assert!(asked <= 6, "{asked} requests");
    assert_eq!(g.stat(MY_DRIVE, "x (2).txt").await.unwrap().unwrap().id.as_deref(), Some("a2"));
}

#[tokio::test]
async fn shortcuts_to_folders_list_as_links_and_walks_stay_out() {
    let mut link = file("s1", "Up", api::SHORTCUT, "2023-01-01T00:00:00Z");
    link["shortcutDetails"] = json!({ "targetId": "root", "targetMimeType": api::FOLDER });
    let mock = drive_with(vec![link, file("f1", "a.txt", "text/plain", "2023-01-01T00:00:00Z")]).await;
    let g = GDrive::with_base(api(fixed("tok")), &mock.base);
    let page = g.list(MY_DRIVE, "", None).await.unwrap();
    assert_eq!(page.folders, vec!["Up/"]);
    assert_eq!(page.folder_link("Up/"), Some("Up"));
    // the shortcut points back at the top: a walk must end
    let mut walk = g.walk(MY_DRIVE, "");
    let mut keys = vec![];
    while let Some(batch) = walk.next().await {
        keys.extend(batch.unwrap().into_iter().map(|e| e.key));
    }
    assert_eq!(keys.len(), 2, "{keys:?}");
}

/// B3-1: a shortcut to a file has no size or MD5 of its own; it lists with its target's, which
/// is what reading it gives (a copy planned from the listing expects those bytes).
#[tokio::test]
async fn shortcuts_to_files_list_with_their_targets_size() {
    let mut link = json!({ "id": "s2", "name": "Report.pdf", "mimeType": api::SHORTCUT, "version": "3", "parents": ["root"], "modifiedTime": "2023-01-01T00:00:00Z" });
    link["shortcutDetails"] = json!({ "targetId": "t1", "targetMimeType": "application/pdf" });
    let mut target = file("t1", "Elsewhere.pdf", "application/pdf", "2024-05-01T00:00:00Z");
    target["size"] = json!("42");
    target["parents"] = json!(["other"]);
    let mock = drive_with(vec![link, target]).await;
    let g = GDrive::with_base(api(fixed("tok")), &mock.base);
    let page = g.list(MY_DRIVE, "", None).await.unwrap();
    let e = page.objects.iter().find(|e| e.key == "Report.pdf").expect("the shortcut");
    assert_eq!(e.size, 42);
    assert_eq!(e.hashes.md5.as_deref(), Some("md5-t1"));
    assert_eq!(e.etag.as_deref(), Some("md5-t1"));
    assert_eq!(e.id.as_deref(), Some("s2"), "still the shortcut");
    let fresh = GDrive::with_base(api(fixed("tok")), &mock.base);
    assert_eq!(fresh.stat(MY_DRIVE, "Report.pdf").await.unwrap().unwrap().size, 42);
}

/// B3-3: a changed file under a parent this account can't read is "not here", not a failed
/// batch, and My Drive's feed doesn't walk up shared drives' files.
#[tokio::test]
async fn drive_changes_skip_unreadable_parents_and_shared_drives() {
    let mock = Mock::start(|req| match req.path.as_str() {
        "/drive/v3/changes" => Resp::json(
            200,
            &json!({ "newStartPageToken": "C2", "changes": [
                { "fileId": "f1", "file": { "id": "f1", "name": "a.txt", "mimeType": "text/plain", "parents": ["hidden"] } },
                { "fileId": "f2", "file": { "id": "f2", "name": "b.txt", "mimeType": "text/plain", "parents": ["sd"], "driveId": "SD1" } },
                { "fileId": "f3", "file": { "id": "f3", "name": "c.txt", "mimeType": "text/plain", "parents": ["0Real"], "size": "3" } },
            ] }),
        ),
        "/drive/v3/files/root" => Resp::json(200, &json!({ "id": "0Real" })),
        "/drive/v3/files/hidden" => Resp::status(403),
        _ => Resp::status(500),
    })
    .await;
    let g = GDrive::with_base(api(fixed("tok")), &mock.base);
    let b = g.changes(MY_DRIVE, Some("C1".into())).await.unwrap();
    assert_eq!(b.cursor, "C2");
    let seen: Vec<(Option<&str>, &str, bool)> = b.changes.iter().map(|c| (c.id.as_deref(), c.key.as_str(), c.entry.is_some())).collect();
    assert_eq!(seen, vec![(Some("f1"), "", false), (Some("f2"), "", false), (Some("f3"), "c.txt", true)]);
    assert!(mock.seen("/drive/v3/files/sd").is_empty(), "no walk up a shared drive");
}

#[tokio::test]
async fn renaming_at_the_top_of_my_drive_is_not_a_move() {
    let mut f = file("f1", "a.txt", "text/plain", "2023-01-01T00:00:00Z");
    f["parents"] = json!(["0Real"]);
    let mock = drive_with(vec![f]).await;
    let g = GDrive::with_base(api(fixed("tok")), &mock.base);
    let loc = |p: &str| Loc { root: MY_DRIVE.into(), path: p.into() };
    let _ = g.rename(&loc("a.txt"), &loc("b.txt"), false).await;
    let patch = mock.seen("/drive/v3/files/f1").into_iter().find(|r| r.method == "PATCH").expect("a PATCH");
    assert_eq!(patch.q("addParents"), None, "{}", patch.query);
    assert_eq!(patch.q("removeParents"), None, "{}", patch.query);
}
