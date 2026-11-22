//! Vault v2, for computers and iOS: the secrets live in `vault.bin` in the app's data folder,
//! encrypted with AES-256-GCM, and only the 32-byte key sits in the keychain (one item,
//! `vault-key`). One keychain prompt as before, and no size limit: Windows Credential Manager
//! refuses items over 2,560 bytes, which a couple of sign-in tokens would pass.
//!
//! Before this, the whole map was the keychain item `connection-secrets`. Losing keys is worse
//! than keeping them the old way a little longer, so moving them is careful:
//! - The old item is only deleted once the new file and key were written and read back to
//!   exactly the same keys.
//! - If an older Kybl wrote the old item again (after a downgrade), its keys are taken in again
//!   on the next start, the same way.
//! - A keychain that can't be read is an error, never "no keys", and nothing is written then.
//! - A file the key can't open is set aside (`vault.bin.unreadable-<time>`), not deleted.
//!
//! No `tauri` here: the keychain is behind [`Keychain`], so tests use an in-memory one.

use std::{
    collections::HashMap,
    io::ErrorKind,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use ring::{
    aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN},
    rand::{SecureRandom, SystemRandom},
};

/// Keychain items of one service (`app.kybl.desktop`), by account name.
pub trait Keychain {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// The keychain item holding the file's key (64 hex digits).
pub const KEY_ACCOUNT: &str = "vault-key";
/// The keychain item that held every secret before vault v2 (a JSON map).
pub const LEGACY_ACCOUNT: &str = "connection-secrets";
const FILE: &str = "vault.bin";
const MAGIC: &[u8; 4] = b"KYV2";
const AAD: &[u8] = b"kybl vault v2";

type Map = HashMap<String, String>;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<[u8; 32]> {
    let s = s.trim();
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

fn cipher(key: &[u8; 32]) -> LessSafeKey {
    LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).expect("a 32-byte key"))
}

fn seal(key: &[u8; 32], plain: &[u8]) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new().fill(&mut nonce).map_err(|_| "No random numbers available".to_string())?;
    let mut body = plain.to_vec();
    cipher(key)
        .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(AAD), &mut body)
        .map_err(|_| "Could not encrypt the secret keys".to_string())?;
    let mut out = MAGIC.to_vec();
    out.extend_from_slice(&nonce);
    out.extend(body);
    Ok(out)
}

fn open(key: &[u8; 32], sealed: &[u8]) -> Option<Map> {
    let rest = sealed.strip_prefix(MAGIC)?;
    if rest.len() < NONCE_LEN {
        return None;
    }
    let (nonce, body) = rest.split_at(NONCE_LEN);
    let mut body = body.to_vec();
    let nonce = Nonce::try_assume_unique_for_key(nonce).ok()?;
    let plain = cipher(key).open_in_place(nonce, Aad::from(AAD), &mut body).ok()?;
    serde_json::from_slice(plain).ok()
}

fn read_key(kc: &impl Keychain) -> Result<Option<[u8; 32]>, String> {
    let raw = kc.get(KEY_ACCOUNT).map_err(|e| format!("Could not read the secret keys from the keychain: {e}"))?;
    Ok(raw.as_deref().and_then(unhex))
}

/// Moves a file nobody can open out of the way, keeping it in case it can be rescued.
fn set_aside(path: &Path) {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let mut to = path.as_os_str().to_owned();
    to.push(format!(".unreadable-{secs}"));
    match std::fs::rename(path, PathBuf::from(&to)) {
        Ok(()) => eprintln!("the secret keys file couldn't be opened and was set aside"),
        Err(e) => eprintln!("the secret keys file couldn't be opened or set aside: {e}"),
    }
}

/// Writes next to the file and renames over it, so a crash never leaves half a file.
fn replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes).map_err(|e| format!("Could not save the secret key: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Could not save the secret key: {e}"))
}

/// Every secret, moving the old keychain item's into the file on the way.
pub fn read(dir: &Path, kc: &impl Keychain) -> Result<Map, String> {
    let path = dir.join(FILE);
    let mut map = Map::new();
    if let Some(key) = read_key(kc)? {
        match std::fs::read(&path) {
            Ok(raw) => match open(&key, &raw) {
                Some(m) => map = m,
                None => set_aside(&path),
            },
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Could not read the secret keys: {e}")),
        }
    }
    let legacy = kc.get(LEGACY_ACCOUNT).map_err(|e| format!("Could not read the secret keys from the keychain: {e}"))?;
    let Some(raw) = legacy else { return Ok(map) };
    // a damaged old item is left alone, as it always was, in case it can still be rescued
    let Ok(old) = serde_json::from_str::<Map>(&raw) else { return Ok(map) };
    // the old item only exists before the first move, or when an older Kybl wrote it since:
    // either way its keys are the newer ones
    map.extend(old);
    match write(dir, kc, &map).and_then(|()| verify(dir, kc, &map)) {
        Ok(()) => {
            if let Err(e) = kc.delete(LEGACY_ACCOUNT) {
                eprintln!("old keychain item not removed: {e}");
            }
        }
        // still usable this time from the old item, which stays until a move works
        Err(e) => eprintln!("secret keys not moved to the vault yet: {e}"),
    }
    Ok(map)
}

/// Reads the vault back from scratch (keychain and file) and checks it holds exactly `map`.
fn verify(dir: &Path, kc: &impl Keychain, map: &Map) -> Result<(), String> {
    let key = read_key(kc)?.ok_or("the vault key didn't save to the keychain")?;
    let raw = std::fs::read(dir.join(FILE)).map_err(|e| e.to_string())?;
    match open(&key, &raw) {
        Some(m) if m == *map => Ok(()),
        _ => Err("the vault didn't read back the same".into()),
    }
}

pub fn write(dir: &Path, kc: &impl Keychain, map: &Map) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not save the secret key: {e}"))?;
    let path = dir.join(FILE);
    let json = serde_json::to_vec(map).map_err(|e| e.to_string())?;
    let key = match read_key(kc)? {
        Some(k) => k,
        None => {
            let mut k = [0u8; 32];
            SystemRandom::new().fill(&mut k).map_err(|_| "No random numbers available".to_string())?;
            // the new key goes into the keychain, and is read back, before anything is sealed
            // with it: a file sealed with a key that didn't save could never be opened again, and
            // the file there now may still open once its own key turns up
            kc.set(KEY_ACCOUNT, &hex(&k)).map_err(|e| format!("Could not save the secret key to the keychain: {e}"))?;
            if read_key(kc)? != Some(k) {
                return Err("Could not save the secret key to the keychain: it didn't read back".into());
            }
            // a file without its key can't be opened any more; keep it aside rather than lose it
            // (unless the old item is still there: then this is a move that failed before, and
            // the old item holds the keys)
            if path.exists() && kc.get(LEGACY_ACCOUNT).ok().flatten().is_none() {
                set_aside(&path);
            }
            k
        }
    };
    let sealed = seal(&key, &json)?;
    replace(&path, &sealed)?;
    match std::fs::read(&path).ok().and_then(|raw| open(&key, &raw)) {
        Some(m) if m == *map => Ok(()),
        _ => Err("Could not save the secret key: the vault didn't read back".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// The keychain, in memory, with ways to make it fail.
    #[derive(Default)]
    struct Mem {
        items: Mutex<HashMap<String, String>>,
        refuse_reads: bool,
        refuse_key_save: bool,
        /// saving the key "works" but stores something else
        garble_key: bool,
    }

    impl Keychain for Mem {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            if self.refuse_reads {
                return Err("user denied access".into());
            }
            Ok(self.items.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, value: &str) -> Result<(), String> {
            if account == KEY_ACCOUNT && self.refuse_key_save {
                return Err("keychain full".into());
            }
            let v = if account == KEY_ACCOUNT && self.garble_key { "00".repeat(32) } else { value.to_string() };
            self.items.lock().unwrap().insert(account.into(), v);
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.items.lock().unwrap().remove(account);
            Ok(())
        }
    }

    impl Mem {
        fn with_legacy(map: &Map) -> Self {
            let m = Mem::default();
            m.items.lock().unwrap().insert(LEGACY_ACCOUNT.into(), serde_json::to_string(map).unwrap());
            m
        }
        fn has(&self, account: &str) -> bool {
            self.items.lock().unwrap().contains_key(account)
        }
    }

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("kybl-vault2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn keys() -> Map {
        HashMap::from([("p1".to_string(), "secret-1".to_string()), ("p2#oauth".to_string(), "{\"refresh\":\"r\"}".to_string())])
    }

    fn files(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn the_old_item_moves_into_the_file_and_only_then_goes() {
        let d = dir();
        let kc = Mem::with_legacy(&keys());
        assert_eq!(read(&d, &kc).unwrap(), keys());
        assert!(!kc.has(LEGACY_ACCOUNT), "the old item is gone once the vault reads back");
        assert!(kc.has(KEY_ACCOUNT));
        let raw = std::fs::read(d.join(FILE)).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("secret-1"), "no key in the clear");
        assert_eq!(read(&d, &kc).unwrap(), keys(), "and it opens again");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_key_that_wont_save_keeps_the_old_item() {
        let d = dir();
        let kc = Mem { refuse_key_save: true, ..Mem::with_legacy(&keys()) };
        assert_eq!(read(&d, &kc).unwrap(), keys(), "still usable from the old item");
        assert!(kc.has(LEGACY_ACCOUNT));
        let kc = Mem { garble_key: true, ..Mem::with_legacy(&keys()) };
        assert_eq!(read(&d, &kc).unwrap(), keys());
        assert!(kc.has(LEGACY_ACCOUNT), "a key that didn't read back is no reason to drop the old item");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_new_key_that_wont_save_leaves_the_file_alone() {
        let d = dir();
        let kc = Mem::default();
        write(&d, &kc, &keys()).unwrap();
        let old_key = kc.items.lock().unwrap().remove(KEY_ACCOUNT).unwrap();
        let before = files(&d);
        let raw = std::fs::read(d.join(FILE)).unwrap();
        // the key item went missing, and the new one won't save (or saves as something else)
        for kc in [Mem { refuse_key_save: true, ..Mem::default() }, Mem { garble_key: true, ..Mem::default() }] {
            let mut more = keys();
            more.insert("p9".into(), "new".into());
            assert!(write(&d, &kc, &more).is_err());
            assert_eq!(files(&d), before, "nothing set aside or replaced");
            assert_eq!(std::fs::read(d.join(FILE)).unwrap(), raw, "the file is still the one the old key opens");
        }
        // the old key turns up again (keychain unlocked, restored from a backup): every secret is there
        let kc = Mem::default();
        kc.set(KEY_ACCOUNT, &old_key).unwrap();
        assert_eq!(read(&d, &kc).unwrap(), keys());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_locked_keychain_is_an_error_and_nothing_changes() {
        let d = dir();
        let kc = Mem { refuse_reads: true, ..Mem::with_legacy(&keys()) };
        assert!(read(&d, &kc).is_err(), "never 'no keys', which the next save would write over");
        assert!(write(&d, &kc, &keys()).is_err());
        assert!(files(&d).is_empty());
        assert!(kc.items.lock().unwrap().contains_key(LEGACY_ACCOUNT));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_fresh_install_starts_empty_and_saves_on_first_write() {
        let d = dir();
        let kc = Mem::default();
        assert!(read(&d, &kc).unwrap().is_empty());
        assert!(files(&d).is_empty() && !kc.has(KEY_ACCOUNT), "nothing made until there is something to keep");
        let mut k = keys();
        write(&d, &kc, &k).unwrap();
        k.remove("p1");
        write(&d, &kc, &k).unwrap();
        assert_eq!(read(&d, &kc).unwrap(), k);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn keys_an_older_kybl_saved_after_a_downgrade_come_back() {
        let d = dir();
        let kc = Mem::with_legacy(&keys());
        read(&d, &kc).unwrap();
        // the older version wrote the old item again: a changed secret and a new connection
        let older = HashMap::from([("p1".to_string(), "secret-1b".to_string()), ("p3".to_string(), "secret-3".to_string())]);
        kc.set(LEGACY_ACCOUNT, &serde_json::to_string(&older).unwrap()).unwrap();
        let m = read(&d, &kc).unwrap();
        assert_eq!(m.get("p1").map(String::as_str), Some("secret-1b"));
        assert_eq!(m.get("p3").map(String::as_str), Some("secret-3"));
        assert_eq!(m.get("p2#oauth"), keys().get("p2#oauth"));
        assert!(!kc.has(LEGACY_ACCOUNT));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_file_the_key_cant_open_is_set_aside_not_lost() {
        let d = dir();
        let kc = Mem::default();
        write(&d, &kc, &keys()).unwrap();
        // another key in the keychain (or a damaged file)
        kc.set(KEY_ACCOUNT, &"11".repeat(32)).unwrap();
        assert!(read(&d, &kc).unwrap().is_empty());
        assert!(files(&d).iter().any(|f| f.starts_with("vault.bin.unreadable-")), "{:?}", files(&d));
        write(&d, &kc, &keys()).unwrap();
        assert_eq!(read(&d, &kc).unwrap(), keys());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_damaged_old_item_is_left_alone() {
        let d = dir();
        let kc = Mem::default();
        kc.set(LEGACY_ACCOUNT, "{not json").unwrap();
        assert!(read(&d, &kc).unwrap().is_empty());
        assert!(kc.has(LEGACY_ACCOUNT));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn no_size_limit_in_the_keychain() {
        let d = dir();
        let kc = Mem::default();
        let big: Map = (0..50).map(|i| (format!("p{i}#oauth"), "x".repeat(1500))).collect();
        write(&d, &kc, &big).unwrap();
        assert!(kc.items.lock().unwrap().values().all(|v| v.len() <= 64), "only the key is in the keychain");
        assert_eq!(read(&d, &kc).unwrap(), big);
        let _ = std::fs::remove_dir_all(d);
    }
}
