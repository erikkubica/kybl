//! End-to-end tests against a real S3 endpoint. They need a throwaway server, e.g.
//! `rclone serve s3 --auth-key testkey,testsecret --addr 127.0.0.1:9123 <dir>` with a
//! `testbucket` folder in `<dir>`, and run with `KYBL_TEST_ENDPOINT=http://127.0.0.1:9123`.
//! Without that variable they are skipped.
//!
//! These are one-way sync's tests from before the split, unchanged: the one-way planners and the
//! generic runner must behave exactly as the S3-only code did.
#[cfg(test)]
#[allow(clippy::module_inception)] // kept as it was, indentation and all
mod tests {
    use crate::sync::{config::*, manager::*};
    use crate::{commands::list_all, state::AppState};
    use std::{
        path::{Path, PathBuf},
        sync::{atomic::AtomicBool, Arc},
        time::Duration,
    };
    use tauri::Manager;
    use crate::state::{build_client, Profile};
    use std::fs;
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

    const PID: &str = "test-profile";
    const BUCKET: &str = "testbucket";

    fn app() -> Option<tauri::App<MockRuntime>> {
        let endpoint = std::env::var("KYBL_TEST_ENDPOINT").ok()?;
        let app = mock_builder()
            .manage(AppState::default())
            .manage(SyncManager::default())
            .build(mock_context(noop_assets()))
            .unwrap();
        let profile = Profile {
            id: PID.into(),
            name: "test".into(),
            provider: "custom".into(),
            endpoint,
            region: "us-east-1".into(),
            access_key_id: "testkey".into(),
            bucket: None,
            path_style: true,
            ..Default::default()
        };
        let client = build_client(&profile, "testsecret");
        tauri::async_runtime::block_on(async {
            app.state::<AppState>().clients.lock().await.insert(PID.into(), client);
        });
        Some(app)
    }

    fn mapping(id: &str, local: &Path, prefix: &str, direction: Direction, mirror: bool) -> SyncMapping {
        SyncMapping {
            id: id.into(),
            profile_id: PID.into(),
            bucket: BUCKET.into(),
            prefix: prefix.into(),
            local_path: local.to_string_lossy().into(),
            direction,
            ignore: vec!["*.tmp".into(), "node_modules/".into(), ".DS_Store".into()],
            mirror_deletes: mirror,
            interval_mins: 5,
            paused: false,
            remote_trash: None,
            delete_guard: true,
        }
    }

    async fn remote_keys(app: &tauri::App<MockRuntime>, prefix: &str) -> Vec<String> {
        let client = app.state::<AppState>().clients.lock().await.get(PID).unwrap().clone();
        let mut keys: Vec<String> = list_all(&client, BUCKET, prefix).await.unwrap().into_iter().map(|o| o.key).collect();
        keys.sort();
        keys
    }

    async fn put(app: &tauri::App<MockRuntime>, key: &str, body: &str) {
        let client = app.state::<AppState>().clients.lock().await.get(PID).unwrap().clone();
        client
            .put_object()
            .bucket(BUCKET)
            .key(key)
            .body(aws_sdk_s3::primitives::ByteStream::from(body.as_bytes().to_vec()))
            .send()
            .await
            .unwrap();
    }

    fn write(p: &Path, body: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("s3b-sync-test-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn cancel() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    #[test]
    fn upload_mapping() {
        let Some(app) = app() else { return eprintln!("skipped: KYBL_TEST_ENDPOINT not set") };
        let h = app.handle().clone();
        tauri::async_runtime::block_on(async move {
            let dir = tmpdir("up");
            let prefix = format!("up-{}/", uuid::Uuid::new_v4());
            write(&dir.join("a.txt"), "hello");
            write(&dir.join("sub/b.txt"), "world");
            write(&dir.join("scratch.tmp"), "ignored");
            write(&dir.join("node_modules/x.js"), "ignored");
            write(&dir.join(".DS_Store"), "ignored");
            let m = mapping("t-up", &dir, &prefix, Direction::Upload, true);
            forget_db(&h, &m.id);

            let r = run_upload(&h, &m, true, &cancel()).await.unwrap();
            assert!(r.errors.is_empty(), "{:?}", r.errors);
            assert_eq!(r.summary, "2 uploaded");
            assert_eq!(remote_keys(&app, &prefix).await, vec![format!("{prefix}a.txt"), format!("{prefix}sub/b.txt")]);

            // nothing changed: nothing to do, quick and full
            assert_eq!(run_upload(&h, &m, false, &cancel()).await.unwrap().summary, "");
            assert_eq!(run_upload(&h, &m, true, &cancel()).await.unwrap().summary, "");

            // an edit goes up on a quick (watcher) run
            std::thread::sleep(Duration::from_millis(20));
            write(&dir.join("a.txt"), "hello again");
            assert_eq!(run_upload(&h, &m, false, &cancel()).await.unwrap().summary, "1 uploaded");

            // removed on S3 behind our back: a full run restores it
            let client = app.state::<AppState>().clients.lock().await.get(PID).unwrap().clone();
            client.delete_object().bucket(BUCKET).key(format!("{prefix}sub/b.txt")).send().await.unwrap();
            assert_eq!(run_upload(&h, &m, true, &cancel()).await.unwrap().summary, "1 uploaded");

            // mirrored deletion
            fs::remove_file(dir.join("sub/b.txt")).unwrap();
            assert_eq!(run_upload(&h, &m, false, &cancel()).await.unwrap().summary, "1 deleted on S3");
            assert_eq!(remote_keys(&app, &prefix).await, vec![format!("{prefix}a.txt")]);

            // newly ignored files are forgotten, not deleted
            let mut m2 = m.clone();
            m2.ignore.push("a.txt".into());
            let r = run_upload(&h, &m2, false, &cancel()).await.unwrap();
            assert_eq!(r.summary, "");
            assert_eq!(remote_keys(&app, &prefix).await, vec![format!("{prefix}a.txt")]);

            // an emptied folder (unmounted drive...) never wipes the bucket
            let r = run_upload(&h, &m, true, &cancel()).await.unwrap(); // re-track a.txt
            assert!(r.errors.is_empty());
            fs::remove_file(dir.join("a.txt")).unwrap();
            let r = run_upload(&h, &m, false, &cancel()).await.unwrap();
            assert_eq!(r.errors.len(), 1, "expected the safety stop");
            assert_eq!(remote_keys(&app, &prefix).await, vec![format!("{prefix}a.txt")]);

            // a missing folder is an error, not "everything was deleted"
            let gone = mapping("t-up-gone", &dir.join("nope"), &prefix, Direction::Upload, true);
            assert!(run_upload(&h, &gone, true, &cancel()).await.is_err());

            forget_db(&h, &m.id);
            let _ = fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn upload_adopts_existing_copy() {
        let Some(app) = app() else { return };
        let h = app.handle().clone();
        tauri::async_runtime::block_on(async move {
            let dir = tmpdir("adopt");
            let prefix = format!("adopt-{}/", uuid::Uuid::new_v4());
            write(&dir.join("same.txt"), "12345");
            std::thread::sleep(Duration::from_millis(1100));
            put(&app, &format!("{prefix}same.txt"), "12345").await; // newer, same size
            let m = mapping("t-adopt", &dir, &prefix, Direction::Upload, false);
            forget_db(&h, &m.id);
            let r = run_upload(&h, &m, true, &cancel()).await.unwrap();
            assert_eq!(r.summary, "", "an identical copy on S3 must not be uploaded again");
            assert_eq!(r.files, 1);
            forget_db(&h, &m.id);
            let _ = fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn download_mapping() {
        let Some(app) = app() else { return };
        let h = app.handle().clone();
        tauri::async_runtime::block_on(async move {
            let dir = tmpdir("down");
            let prefix = format!("down-{}/", uuid::Uuid::new_v4());
            put(&app, &format!("{prefix}one.txt"), "one").await;
            put(&app, &format!("{prefix}deep/two.txt"), "two").await;
            put(&app, &format!("{prefix}skip.tmp"), "ignored").await;
            // (folder markers like "dir/" can't be tested here: rclone stores them as plain files)
            let m = mapping("t-down", &dir, &prefix, Direction::Download, false);
            forget_db(&h, &m.id);

            let r = run_download(&h, &m, &cancel()).await.unwrap();
            assert!(r.errors.is_empty(), "{:?}", r.errors);
            assert_eq!(r.summary, "2 downloaded");
            assert_eq!(fs::read_to_string(dir.join("one.txt")).unwrap(), "one");
            assert_eq!(fs::read_to_string(dir.join("deep/two.txt")).unwrap(), "two");
            assert!(!dir.join("skip.tmp").exists());
            assert_eq!(run_download(&h, &m, &cancel()).await.unwrap().summary, "");

            // changed remotely, untouched locally: overwritten
            put(&app, &format!("{prefix}one.txt"), "one v2").await;
            assert_eq!(run_download(&h, &m, &cancel()).await.unwrap().summary, "1 downloaded");
            assert_eq!(fs::read_to_string(dir.join("one.txt")).unwrap(), "one v2");

            // edited locally only: left alone
            std::thread::sleep(Duration::from_millis(20));
            write(&dir.join("one.txt"), "my local edit");
            assert_eq!(run_download(&h, &m, &cancel()).await.unwrap().summary, "1 local edit not overwritten");
            assert_eq!(fs::read_to_string(dir.join("one.txt")).unwrap(), "my local edit");

            // edited on both sides: the local edit is kept as a copy
            put(&app, &format!("{prefix}one.txt"), "one v3").await;
            let r = run_download(&h, &m, &cancel()).await.unwrap();
            assert_eq!(r.summary, "1 downloaded · 1 edited file kept as local copies");
            assert_eq!(fs::read_to_string(dir.join("one.txt")).unwrap(), "one v3");
            assert_eq!(fs::read_to_string(dir.join("one (local copy).txt")).unwrap(), "my local edit");

            // deleted locally: the mirror restores it
            fs::remove_file(dir.join("deep/two.txt")).unwrap();
            assert_eq!(run_download(&h, &m, &cancel()).await.unwrap().summary, "1 downloaded");
            assert!(dir.join("deep/two.txt").exists());

            // removed remotely without mirror deletions: local copy stays
            let client = app.state::<AppState>().clients.lock().await.get(PID).unwrap().clone();
            client.delete_object().bucket(BUCKET).key(format!("{prefix}deep/two.txt")).send().await.unwrap();
            run_download(&h, &m, &cancel()).await.unwrap();
            assert!(dir.join("deep/two.txt").exists());

            // with mirror deletions an empty listing never empties the local folder
            let mut wipe = mapping("t-down-wipe", &dir, &format!("{prefix}deep/"), Direction::Download, true);
            wipe.ignore.clear();
            forget_db(&h, &wipe.id);
            put(&app, &format!("{prefix}deep/three.txt"), "3").await;
            run_download(&h, &wipe, &cancel()).await.unwrap();
            client.delete_object().bucket(BUCKET).key(format!("{prefix}deep/three.txt")).send().await.unwrap();
            let r = run_download(&h, &wipe, &cancel()).await.unwrap();
            assert_eq!(r.errors.len(), 1, "expected the safety stop");
            assert!(dir.join("three.txt").exists());

            forget_db(&h, &m.id);
            forget_db(&h, &wipe.id);
            let _ = fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn watcher_uploads_changes() {
        let Some(app) = app() else { return };
        let h = app.handle().clone();
        tauri::async_runtime::block_on(async move {
            let dir = tmpdir("watch");
            let prefix = format!("watch-{}/", uuid::Uuid::new_v4());
            let m = mapping("t-watch", &dir, &prefix, Direction::Upload, false);
            forget_db(&h, &m.id);
            let mgr = h.state::<SyncManager>();
            apply(&h, &mgr, &m, false).await;
            tokio::time::sleep(Duration::from_secs(4)).await; // first full run
            write(&dir.join("new.txt"), "watched");
            let mut ok = false;
            for _ in 0..30 {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if remote_keys(&app, &prefix).await.contains(&format!("{prefix}new.txt")) {
                    ok = true;
                    break;
                }
            }
            stop_worker(&mgr, &m.id).await;
            assert!(ok, "the watcher should upload a new file within seconds");
            let st = mgr.statuses().into_iter().find(|s| s.id == m.id).unwrap();
            assert_eq!(st.state, "idle");
            forget_db(&h, &m.id);
            let _ = fs::remove_dir_all(&dir);
        });
    }
}
