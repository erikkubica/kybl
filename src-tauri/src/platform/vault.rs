//! Android keeps the secret keys in a file in the app's private storage. This seals that file
//! with a key held by the Android Keystore (which never leaves the secure hardware where there
//! is one), so a copy of the app's data alone doesn't give the keys away.
//!
//! Losing keys is worse than keeping them unsealed, so every step is careful:
//! - The old plain file (`secrets.json`) is only deleted once the sealed one (`secrets.bin`) has
//!   been written, read back and opened to exactly the same content.
//! - A sealed file that can't be opened is an error, never "no keys": the file stays as it is,
//!   and nothing is written over it.
//! - A phone whose Keystore doesn't work keeps using the plain file, as before.

use std::{
    collections::HashMap,
    io::ErrorKind,
    path::{Path, PathBuf},
};

/// Seals and opens bytes; the Keystore on Android (`super::android::Keystore`).
pub trait Sealer {
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String>;
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String>;
}

const PLAIN: &str = "secrets.json";
const SEALED: &str = "secrets.bin";

/// In a sealer's error when the key that sealed the file is gone for good (the Keystore dropped
/// or invalidated it, say after the screen lock was removed or a backup restored onto another
/// phone). Sent by `SecretBox.kt`.
pub const KEY_GONE: &str = "kybl-vault-key-gone";

pub fn read(dir: &Path, sealer: &impl Sealer) -> Result<HashMap<String, String>, String> {
    match std::fs::read(dir.join(SEALED)) {
        Ok(raw) => {
            let plain = match sealer.open(&raw) {
                Ok(p) => p,
                Err(e) if e.contains(KEY_GONE) => return Err(set_aside(dir, &e)),
                Err(e) => return Err(format!("Could not unlock the secret keys: {e}")),
            };
            return serde_json::from_slice(&plain).map_err(|e| format!("Could not read the secret keys: {e}"));
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Could not read the secret keys: {e}")),
    }
    let raw = match std::fs::read(dir.join(PLAIN)) {
        Ok(raw) => raw,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(format!("Could not read the secret keys: {e}")),
    };
    // a damaged plain file reads as empty, as it always did; it is not sealed (and so not
    // deleted) here, in case it can still be rescued. The next save would replace or delete it,
    // so a copy is kept first (`secrets.json.unreadable-<time>`)
    let Ok(map) = serde_json::from_slice::<HashMap<String, String>>(&raw) else {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let copy = dir.join(format!("{PLAIN}.unreadable-{stamp}"));
        if let Err(e) = crate::state::write_atomic(&copy, &raw) {
            eprintln!("damaged secret keys file not kept aside: {e}");
        }
        return Ok(HashMap::new());
    };
    // seal the keys of an earlier version right away rather than on the next save
    if !map.is_empty() {
        if let Err(e) = write(dir, &map, sealer) {
            eprintln!("secret keys not sealed yet: {e}");
        }
    }
    Ok(map)
}

pub fn write(dir: &Path, map: &HashMap<String, String>, sealer: &impl Sealer) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not save the secret key: {e}"))?;
    let json = serde_json::to_vec(map).map_err(|e| e.to_string())?;
    let sealed_path = dir.join(SEALED);
    let sealed = match sealer.seal(&json) {
        Ok(s) => s,
        Err(e) => {
            // no working Keystore: keep the keys the way earlier versions did
            eprintln!("Keystore unavailable, secret keys stay in the private file: {e}");
            return write_plain(dir, &json);
        }
    };
    replace(&sealed_path, &sealed)?;
    let readable = std::fs::read(&sealed_path).ok().and_then(|raw| sealer.open(&raw).ok());
    if readable.as_deref() != Some(&json[..]) {
        eprintln!("the sealed secret keys didn't read back: keeping the private file");
        return write_plain(dir, &json);
    }
    match std::fs::remove_file(dir.join(PLAIN)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        // the sealed file is read first, so a plain one left behind is only untidy
        Err(e) => {
            eprintln!("old secret keys file not removed: {e}");
            Ok(())
        }
    }
}

/// A sealed file nothing can open any more would block every connection for good, so it is moved
/// aside (never deleted: `secrets.bin.broken-<time>`), and the error says so once; after that the
/// vault reads as empty and keys entered again are sealed with a new key.
fn set_aside(dir: &Path, why: &str) -> String {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let aside = format!("{SEALED}.broken-{stamp}");
    if let Err(e) = std::fs::rename(dir.join(SEALED), dir.join(&aside)) {
        return format!("Could not unlock the secret keys: {why} ({e})");
    }
    eprintln!("secret keys can't be opened any more ({why}): kept as {aside}");
    "This phone can no longer unlock the secret keys Kybl saved (its secure key store dropped the key, which can happen after changing the screen lock). Edit each connection and enter its secret key again.".into()
}

/// The plain file, as before sealing. A sealed file would be read instead of it, so that goes,
/// but only once the plain file holds everything.
fn write_plain(dir: &Path, json: &[u8]) -> Result<(), String> {
    replace(&dir.join(PLAIN), json)?;
    match std::fs::remove_file(dir.join(SEALED)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not save the secret key: {e}")),
    }
}

/// Writes next to the file (a temporary name of its own, so two copies of the app saving at once
/// never mix their bytes) and renames over it, so a crash never leaves half a file.
fn replace(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    crate::state::write_atomic(path, bytes).map_err(|e| format!("Could not save the secret key: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stands in for the Keystore: a fixed XOR with a header, so sealed bytes differ from plain.
    struct Fake {
        broken_seal: bool,
        /// sealing works but what it makes can't be opened again
        garbles: bool,
    }

    fn fake() -> Fake {
        Fake { broken_seal: false, garbles: false }
    }

    impl Sealer for Fake {
        fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
            if self.broken_seal {
                return Err("no keystore".into());
            }
            let mut out = b"KYB1".to_vec();
            out.extend(plain.iter().map(|b| b ^ 0x5a));
            if self.garbles {
                out.push(0);
            }
            Ok(out)
        }
        fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
            let body = sealed.strip_prefix(b"KYB1").ok_or("not sealed")?;
            Ok(body.iter().map(|b| b ^ 0x5a).collect())
        }
    }

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("kybl-vault-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn keys() -> HashMap<String, String> {
        HashMap::from([("p1".to_string(), "secret-1".to_string()), ("p2".to_string(), "secret-2".to_string())])
    }

    #[test]
    fn keys_of_an_earlier_version_are_sealed_and_the_plain_file_goes() {
        let d = dir();
        std::fs::write(d.join(PLAIN), serde_json::to_vec(&keys()).unwrap()).unwrap();
        let s = fake();
        assert_eq!(read(&d, &s).unwrap(), keys());
        assert!(!d.join(PLAIN).exists(), "the plain file is gone once the sealed one reads back");
        let sealed = std::fs::read(d.join(SEALED)).unwrap();
        assert!(!String::from_utf8_lossy(&sealed).contains("secret-1"), "no key in the clear");
        assert_eq!(read(&d, &s).unwrap(), keys(), "and it opens again");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_damaged_plain_file_is_kept_aside_before_a_save_can_replace_it() {
        let d = dir();
        std::fs::write(d.join(PLAIN), b"{\"p1\": \"secret-1\", broken").unwrap();
        let s = fake();
        assert!(read(&d, &s).unwrap().is_empty());
        let kept: Vec<_> = std::fs::read_dir(&d).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("secrets.json.unreadable-")).collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(std::fs::read(kept[0].path()).unwrap(), b"{\"p1\": \"secret-1\", broken");
        // saving the one key entered again removes the damaged original, but not the copy
        write(&d, &HashMap::from([("p2".to_string(), "x".to_string())]), &s).unwrap();
        assert!(!d.join(PLAIN).exists());
        assert!(kept[0].path().exists());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_sealed_file_that_wont_open_is_an_error_and_stays_untouched() {
        let d = dir();
        std::fs::write(d.join(SEALED), b"garbage").unwrap();
        std::fs::write(d.join(PLAIN), serde_json::to_vec(&keys()).unwrap()).unwrap();
        assert!(read(&d, &fake()).is_err(), "never 'no keys', which the next save would write over");
        assert_eq!(std::fs::read(d.join(SEALED)).unwrap(), b"garbage");
        assert!(d.join(PLAIN).exists());
        let _ = std::fs::remove_dir_all(d);
    }

    /// Opens nothing: the key is gone.
    struct KeyGone;

    impl Sealer for KeyGone {
        fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
            fake().seal(plain)
        }
        fn open(&self, _: &[u8]) -> Result<Vec<u8>, String> {
            Err(format!("java.lang.IllegalStateException: {KEY_GONE}: the key is gone"))
        }
    }

    #[test]
    fn a_file_whose_key_is_gone_is_set_aside_once_and_kept() {
        let d = dir();
        write(&d, &keys(), &fake()).unwrap();
        let sealed = std::fs::read(d.join(SEALED)).unwrap();
        let e = read(&d, &KeyGone).unwrap_err();
        assert!(e.contains("enter its secret key again"), "{e}");
        let aside: Vec<_> = std::fs::read_dir(&d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        let broken = aside.iter().find(|n| n.starts_with("secrets.bin.broken-")).expect("kept, not deleted");
        assert_eq!(std::fs::read(d.join(broken)).unwrap(), sealed);
        // from now on: empty, and saving works with a new key
        assert!(read(&d, &KeyGone).unwrap().is_empty());
        write(&d, &keys(), &fake()).unwrap();
        assert_eq!(read(&d, &fake()).unwrap(), keys());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn without_a_keystore_the_plain_file_is_kept() {
        let d = dir();
        let s = Fake { broken_seal: true, ..fake() };
        write(&d, &keys(), &s).unwrap();
        assert!(d.join(PLAIN).exists() && !d.join(SEALED).exists());
        assert_eq!(read(&d, &s).unwrap(), keys());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_seal_that_doesnt_read_back_keeps_the_plain_file() {
        let d = dir();
        std::fs::write(d.join(PLAIN), serde_json::to_vec(&keys()).unwrap()).unwrap();
        let s = Fake { garbles: true, ..fake() };
        assert_eq!(read(&d, &s).unwrap(), keys());
        assert!(d.join(PLAIN).exists(), "kept: the sealed copy didn't match");
        assert!(!d.join(SEALED).exists(), "and the bad sealed copy is gone, so it can't shadow it");
        assert_eq!(read(&d, &fake()).unwrap(), keys());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn saving_seals_and_an_empty_vault_reads_empty() {
        let d = dir();
        let s = fake();
        assert!(read(&d, &s).unwrap().is_empty());
        let mut k = keys();
        write(&d, &k, &s).unwrap();
        k.remove("p1");
        write(&d, &k, &s).unwrap();
        assert_eq!(read(&d, &s).unwrap(), k);
        assert!(!d.join(PLAIN).exists());
        let _ = std::fs::remove_dir_all(d);
    }
}
