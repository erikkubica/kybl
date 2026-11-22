//! Engine tests: items from temporary files backed up to a folder on this computer served as a
//! connection (the same `LocalBackend` the app uses for this device), no network.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use async_trait::async_trait;

use super::{engine::*, index, types::*};
use crate::storage::{local::LocalBackend, RootKind, SResult, Storage, StorageError};

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn tmp() -> Tmp {
    let p = std::env::temp_dir().join(format!("kybl-backup-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&p).unwrap();
    Tmp(std::fs::canonicalize(&p).unwrap())
}

fn write(base: &Path, rel: &str, data: &[u8]) -> PathBuf {
    let p = base.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, data).unwrap();
    p
}

/// Named files under `dir` (writes' hidden temporary files left out), with contents.
fn files(dir: &Path) -> HashMap<String, Vec<u8>> {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && !e.file_name().to_string_lossy().contains(".kybl-"))
        .map(|e| (e.path().strip_prefix(dir).unwrap().to_string_lossy().replace('\\', "/"), std::fs::read(e.path()).unwrap()))
        .collect()
}

#[derive(Default)]
struct TestHost {
    conns: Mutex<HashMap<String, Arc<dyn Storage>>>,
    metered: AtomicBool,
    events: Mutex<Vec<SetStatus>>,
}

#[async_trait]
impl Host for TestHost {
    async fn open(&self, profile_id: &str) -> SResult<Arc<dyn Storage>> {
        self.conns.lock().unwrap().get(profile_id).cloned().ok_or_else(|| StorageError::other("no such connection"))
    }
    fn emit(&self, s: &SetStatus) {
        self.events.lock().unwrap().push(s.clone());
    }
    fn metered(&self) -> bool {
        self.metered.load(Ordering::Relaxed)
    }
}

/// An engine backing up to `dest` (connection "dst"), and a camera roll set going to "Camera/".
fn engine(dest: &Path) -> (Core, Arc<TestHost>, BackupSet) {
    let b = LocalBackend::with_roots(vec![("Test".into(), RootKind::Folder, dest.to_path_buf())], false);
    let host = Arc::new(TestHost::default());
    host.conns.lock().unwrap().insert("dst".into(), Arc::new(b));
    let core = Core::new(crate::db::open_in_memory(index::MIGRATIONS).unwrap(), host.clone());
    let set = core
        .save_set(BackupSet { profile_id: "dst".into(), root: dest.to_str().unwrap().into(), dest_prefix: "/Camera".into(), ..Default::default() })
        .unwrap();
    (core, host, set)
}

// 2026-03-01T00:30:00Z
const T: i64 = 1_772_325_000_000;

fn photo(id: &str, name: &str, size: i64, modified: i64) -> Item {
    Item { source_id: id.into(), kind: ItemKind::Photo, name: name.into(), size, created: Some(T), modified: Some(modified), ..Default::default() }
}

fn run<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

#[test]
fn a_new_set_gets_an_id_and_a_tidy_folder() {
    let d = tmp();
    let (core, _, set) = engine(&d.0);
    assert!(!set.id.is_empty());
    assert_eq!(set.dest_prefix, "Camera/");
    assert!(set.created > 0);
    assert_eq!(core.sets().unwrap().len(), 1);
    assert!(core.save_set(BackupSet::default()).unwrap_err().contains("Choose where"));
}

#[test]
fn offers_upload_once_and_again_only_when_changed() {
    let (d, src) = (tmp(), tmp());
    let (core, _, set) = engine(&d.0);
    let id = set.id.as_str();
    let a = write(&src.0, "a.heic", b"aaaa");
    let b = write(&src.0, "b.mov", b"bbbbbbbb");
    assert!(core.run_start(id).unwrap());
    // a second worker can't run the same set at the same time
    assert!(!core.run_start(id).unwrap());

    let mut v = photo("v1", "IMG_0002.MOV", 8, 5);
    v.kind = ItemKind::Video;
    let items = vec![photo("p1", "IMG_0001.HEIC", 4, 5), v];
    let offers = core.offer(id, &items).unwrap();
    assert_eq!(offers.iter().map(|o| o.remote_path.as_str()).collect::<Vec<_>>(), ["Camera/2026/03/IMG_0001.HEIC", "Camera/2026/03/IMG_0002.MOV"]);
    // offered twice before uploading: still one queue entry each
    assert_eq!(core.offer(id, &items).unwrap().len(), 2);
    assert_eq!(core.pending(id, 100).unwrap().len(), 2);

    let r = run(core.upload(id, "p1", Source::Path(a.clone()), 4, Some(T)));
    assert_eq!(r, UploadResult::at("done", "Camera/2026/03/IMG_0001.HEIC"));
    let r = run(core.upload(id, "v1", Source::Path(b.clone()), 8, None));
    assert_eq!(r.status, "done");
    // uploading what is no longer pending does nothing
    assert_eq!(run(core.upload(id, "v1", Source::Path(b), 8, None)).status, "skipped");
    core.run_end(id, None).unwrap();

    let got = files(&d.0);
    assert_eq!(got["Camera/2026/03/IMG_0001.HEIC"], b"aaaa");
    assert_eq!(got["Camera/2026/03/IMG_0002.MOV"], b"bbbbbbbb");
    let st = core.status(id).unwrap();
    assert_eq!((st.backed_up, st.pending, st.failed, st.state), (2, 0, 0, RunState::Idle));
    assert!(st.last_run.is_some());

    // the next run: nothing new
    assert!(core.offer(id, &items).unwrap().is_empty());
    // the photo was edited (new modified time and size): it goes up again, over its old copy
    write(&src.0, "a.heic", b"edited!");
    let offers = core.offer(id, &[photo("p1", "IMG_0001.HEIC", 7, 6)]).unwrap();
    assert_eq!(offers[0].remote_path, "Camera/2026/03/IMG_0001.HEIC");
    assert_eq!(run(core.upload(id, "p1", Source::Path(a), 7, None)).status, "done");
    assert_eq!(files(&d.0)["Camera/2026/03/IMG_0001.HEIC"], b"edited!");
    assert_eq!(files(&d.0).len(), 2);
}

#[test]
fn a_different_file_with_the_name_gets_a_number() {
    let (d, src) = (tmp(), tmp());
    let (core, _, set) = engine(&d.0);
    let id = set.id.as_str();
    // already in the destination: a different picture with the same name
    write(&d.0, "Camera/2026/03/IMG_0001.HEIC", b"someone else's");
    let mine = write(&src.0, "x", b"mine");
    core.offer(id, &[photo("p1", "IMG_0001.HEIC", 4, 1)]).unwrap();
    let r = run(core.upload(id, "p1", Source::Path(mine), 4, None));
    assert_eq!(r, UploadResult::at("done", "Camera/2026/03/IMG_0001 (2).HEIC"));
    let got = files(&d.0);
    assert_eq!(got["Camera/2026/03/IMG_0001.HEIC"], b"someone else's");
    assert_eq!(got["Camera/2026/03/IMG_0001 (2).HEIC"], b"mine");

    // two items of this phone with one name (same size, so it's not "already there"): the
    // second is never taken for the first one's backup
    let other = write(&src.0, "y", b"MINE");
    core.offer(id, &[photo("p2", "IMG_0001.HEIC", 4, 1)]).unwrap();
    let r = run(core.upload(id, "p2", Source::Path(other), 4, None));
    assert_eq!(r, UploadResult::at("done", "Camera/2026/03/IMG_0001 (3).HEIC"));
}

#[test]
fn a_first_run_adopts_what_is_already_there() {
    let (d, src) = (tmp(), tmp());
    let (core, _, set) = engine(&d.0);
    let id = set.id.as_str();
    // backed up earlier by another app: same name, same size, same time
    write(&d.0, "Camera/2026/03/IMG_0001.HEIC", b"1234");
    let before = std::fs::metadata(d.0.join("Camera/2026/03/IMG_0001.HEIC")).unwrap().modified().unwrap();
    let ms = before.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let f = write(&src.0, "x", b"1234");
    core.offer(id, &[photo("p1", "IMG_0001.HEIC", 4, 1)]).unwrap();
    let r = run(core.upload(id, "p1", Source::Path(f), 4, Some(ms + 1500)));
    assert_eq!(r, UploadResult::at("adopted", "Camera/2026/03/IMG_0001.HEIC"));
    // not written again
    assert_eq!(files(&d.0)["Camera/2026/03/IMG_0001.HEIC"], b"1234");
    assert_eq!(std::fs::metadata(d.0.join("Camera/2026/03/IMG_0001.HEIC")).unwrap().modified().unwrap(), before);
    assert_eq!(core.status(id).unwrap().backed_up, 1);
    assert!(core.offer(id, &[photo("p1", "IMG_0001.HEIC", 4, 1)]).unwrap().is_empty());
}

#[test]
fn a_different_photo_of_the_same_name_and_size_is_never_adopted() {
    let (d, src) = (tmp(), tmp());
    let (core, _, set) = engine(&d.0);
    let id = set.id.as_str();
    // a camera counter that started over: another photo, same name and size
    write(&d.0, "Camera/2026/03/IMG_0001.HEIC", b"1234");
    let f = write(&src.0, "x", b"abcd");
    core.offer(id, &[photo("p1", "IMG_0001.HEIC", 4, 1)]).unwrap();
    let r = run(core.upload(id, "p1", Source::Path(f.clone()), 4, Some(1)));
    assert_eq!(r, UploadResult::at("done", "Camera/2026/03/IMG_0001 (2).HEIC"));
    assert_eq!(files(&d.0)["Camera/2026/03/IMG_0001.HEIC"], b"1234");
    assert_eq!(files(&d.0)["Camera/2026/03/IMG_0001 (2).HEIC"], b"abcd");

    // with hashes on both sides, the hash decides whatever the times say
    let e = crate::storage::Entry { key: "k".into(), size: 4, modified: Some(1), ..Default::default() };
    assert!(same_file(&e, 4, Some(5_000_000), Some("AB"), Some("ab")));
    assert!(!same_file(&e, 4, Some(1), Some("ab"), Some("cd")));
    assert!(same_file(&e, 4, Some(1999), None, None));
    assert!(!same_file(&e, 4, None, None, None), "no time, no hash: not proof");
    assert!(!same_file(&e, 5, Some(1), None, None));
}

#[test]
fn options_filter_what_is_offered() {
    let d = tmp();
    let (core, _, mut set) = engine(&d.0);
    set.include_videos = false;
    set.live_photo_video = false;
    set.since = Some(T + 1);
    let set = core.save_set(set).unwrap();
    let mut v = photo("v", "a.mov", 1, 1);
    v.kind = ItemKind::Video;
    let mut l = photo("l", "a_live.mov", 1, 1);
    l.kind = ItemKind::LivePhotoVideo;
    let old = photo("old", "old.jpg", 1, 1);
    let mut new = photo("new", "new.jpg", 1, 1);
    new.created = Some(T + 5);
    let offers = core.offer(&set.id, &[v, l, old, new]).unwrap();
    assert_eq!(offers.iter().map(|o| o.source_id.as_str()).collect::<Vec<_>>(), ["new"]);
    // paused: nothing is offered and no run starts
    core.set_enabled(&set.id, false).unwrap();
    assert!(core.offer(&set.id, &[photo("x", "x.jpg", 1, 1)]).unwrap().is_empty());
    assert!(!core.run_start(&set.id).unwrap());
    assert_eq!(core.status(&set.id).unwrap().state, RunState::Paused);
}

#[test]
fn failures_are_kept_counted_and_retried() {
    let d = tmp();
    let (core, _, set) = engine(&d.0);
    let id = set.id.as_str();
    core.offer(id, &[photo("p1", "a.jpg", 3, 1), photo("p2", "b.jpg", 3, 1)]).unwrap();
    // the phone couldn't export p1, three times
    for _ in 0..index::MAX_ATTEMPTS {
        core.fail(id, "p1", "iCloud didn't send the original.").unwrap();
    }
    // the source file is gone: the upload fails and says so
    let r = run(core.upload(id, "p2", Source::Path(d.0.join("missing")), 3, None));
    assert_eq!(r.status, "failed");
    let st = core.status(id).unwrap();
    assert_eq!((st.pending, st.failed), (0, 2));
    let f = core.failures(id).unwrap();
    assert_eq!(f.len(), 2);
    assert!(f.iter().any(|x| x.name == "a.jpg" && x.error.contains("iCloud") && x.attempts == 3));
    // p1 failed too often for automatic runs; p2 is tried again
    assert_eq!(core.pending(id, 10).unwrap().iter().map(|o| o.source_id.as_str()).collect::<Vec<_>>(), ["p2"]);
    assert_eq!(core.retry_failed(id).unwrap(), 2);
    assert_eq!(core.pending(id, 10).unwrap().len(), 2);
    assert_eq!(core.status(id).unwrap().failed, 0);
    // an item deleted from the phone leaves the queue
    core.gone(id, "p1").unwrap();
    assert_eq!(core.pending(id, 10).unwrap().len(), 1);
}

#[test]
fn wifi_only_cancel_and_missing_connections_stop_the_run() {
    let (d, src) = (tmp(), tmp());
    let (core, host, set) = engine(&d.0);
    let id = set.id.as_str();
    let f = write(&src.0, "x", b"abc");
    core.offer(id, &[photo("p1", "a.jpg", 3, 1)]).unwrap();
    assert!(core.run_start(id).unwrap());

    host.metered.store(true, Ordering::Relaxed);
    assert_eq!(run(core.upload(id, "p1", Source::Path(f.clone()), 3, None)).status, "waitingWifi");
    assert_eq!(core.status(id).unwrap().state, RunState::WaitingWifi);
    host.metered.store(false, Ordering::Relaxed);

    core.cancel(Some(id));
    assert_eq!(run(core.upload(id, "p1", Source::Path(f.clone()), 3, None)).status, "cancelled");
    core.run_end(id, None).unwrap();

    // a new run (a run that ended waiting for Wi-Fi doesn't block it), but the connection was
    // removed: the item fails and says why
    assert!(core.run_start(id).unwrap());
    host.conns.lock().unwrap().clear();
    let r = run(core.upload(id, "p1", Source::Path(f), 3, None));
    assert_eq!(r.status, "failed");
    assert!(r.error.unwrap().contains("no such connection"));
    assert!(!host.events.lock().unwrap().is_empty());
}

#[test]
fn file_descriptors_stream_and_reread_any_part() {
    let (d, src) = (tmp(), tmp());
    let (core, _, set) = engine(&d.0);
    let id = set.id.as_str();
    let data: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
    let p = write(&src.0, "big.mp4", &data);
    let mut v = photo("v1", "VID_1.MP4", data.len() as i64, 1);
    v.kind = ItemKind::Video;
    core.offer(id, &[v]).unwrap();
    let file = std::fs::File::open(&p).unwrap();
    let r = run(core.upload(id, "v1", Source::File(file), data.len() as i64, Some(T)));
    assert_eq!(r.status, "done");
    let out = d.0.join("Camera/2026/03/VID_1.MP4");
    assert_eq!(std::fs::read(&out).unwrap(), data);
    // the modification time was kept
    let mtime = std::fs::metadata(&out).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    assert_eq!(mtime / 1000, T / 1000);
}

#[test]
fn headless_entry_points_drive_a_whole_run() {
    let (d, src) = (tmp(), tmp());
    let (core, _, set) = engine(&d.0);
    *super::CORE.lock().unwrap() = Some(Arc::new(core));
    let id = set.id.clone();
    use super::headless::{call, offer, upload};
    let ok = |s: String| -> serde_json::Value {
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert!(v.get("error").is_none(), "{s}");
        v["ok"].clone()
    };
    assert_eq!(ok(call("sets", "{}"))[0]["id"], id.as_str());
    ok(call("device", r#"{"name":"Pixel 9"}"#));
    assert_eq!(ok(call("runStart", &format!(r#"{{"setId":"{id}"}}"#)))["run"], true);
    let items = r#"[{"sourceId":"external_primary:12","kind":"photo","name":"PXL_1.jpg","size":5,"created":1772325000000,"modified":1772325000000,"tzOffset":60},
                    {"sourceId":"external_primary:13","kind":"photo","name":"PXL_2.jpg","size":3,"created":1772325000000,"modified":1772325000000}]"#;
    let offered: serde_json::Value = serde_json::from_str(&offer(&id, items)).unwrap();
    assert_eq!(offered[0]["remotePath"], "Camera/2026/03/PXL_1.jpg");
    let pending = ok(call("pending", &format!(r#"{{"setId":"{id}"}}"#)));
    assert_eq!(pending.as_array().unwrap().len(), 2);

    let f = write(&src.0, "p", b"hello");
    let r: UploadResult = serde_json::from_str(&upload(&id, "external_primary:12", Source::File(std::fs::File::open(&f).unwrap()), 5, 0)).unwrap();
    assert_eq!(r, UploadResult::at("done", "Camera/2026/03/PXL_1.jpg"));
    ok(call("fail", &format!(r#"{{"setId":"{id}","sourceId":"external_primary:13","error":"Can't open"}}"#)));
    ok(call("runEnd", &format!(r#"{{"setId":"{id}"}}"#)));
    let st = ok(call("status", &format!(r#"{{"setId":"{id}"}}"#)));
    assert_eq!((st["backedUp"].as_u64(), st["failed"].as_u64(), st["state"].as_str()), (Some(1), Some(1), Some("idle")));
    // a template with {device}
    let mut set2 = set.clone();
    set2.template = "{device}/{name}".into();
    super::core().unwrap().save_set(set2).unwrap();
    let again: serde_json::Value = serde_json::from_str(&offer(&id, r#"[{"sourceId":"n","name":"x.jpg","size":1}]"#)).unwrap();
    assert_eq!(again[0]["remotePath"], "Camera/Pixel 9/x.jpg");
    // errors come back as JSON, never a panic
    assert!(call("runStart", r#"{"setId":"nope"}"#).contains("error"));
    assert!(call("teleport", "{}").contains("Unknown backup call"));
    assert!(call("offer", "not json").contains("Bad arguments"));
    assert_eq!(files(&d.0)["Camera/2026/03/PXL_1.jpg"], b"hello");
}
