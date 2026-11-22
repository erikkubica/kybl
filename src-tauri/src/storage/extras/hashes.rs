//! The content hashes OneDrive and Dropbox report, computed locally the same way, so a sync or a
//! copy can tell whether a file already matches without downloading it.

use base64::Engine;

/// OneDrive's QuickXorHash: 160 bits, each byte XORed in 11 bits further along, then the length
/// XORed into the last 8 bytes. Graph reports it base64-encoded (`file.hashes.quickXorHash`).
/// A port of Microsoft's reference implementation.
pub struct QuickXor {
    data: [u64; 3],
    shift_so_far: usize,
    length: u64,
}

const WIDTH: usize = 160;
const SHIFT: usize = 11;

impl Default for QuickXor {
    fn default() -> Self {
        Self::new()
    }
}

impl QuickXor {
    pub fn new() -> Self {
        Self { data: [0; 3], shift_so_far: 0, length: 0 }
    }

    pub fn update(&mut self, bytes: &[u8]) {
        let size = bytes.len();
        let mut index = self.shift_so_far / 64;
        let mut offset = self.shift_so_far % 64;
        for i in 0..size.min(WIDTH) {
            let last = index == self.data.len() - 1;
            let cell_bits = if last { WIDTH % 64 } else { 64 };
            if offset + 8 <= cell_bits {
                let mut j = i;
                while j < size {
                    self.data[index] ^= (bytes[j] as u64) << offset;
                    j += WIDTH;
                }
            } else {
                let index2 = if last { 0 } else { index + 1 };
                let low = cell_bits - offset;
                let mut x = 0u8;
                let mut j = i;
                while j < size {
                    x ^= bytes[j];
                    j += WIDTH;
                }
                self.data[index] ^= (x as u64) << offset;
                self.data[index2] ^= (x as u64) >> low;
            }
            offset += SHIFT;
            while offset >= cell_bits {
                index = if last { 0 } else { index + 1 };
                offset -= cell_bits;
            }
        }
        self.shift_so_far = (self.shift_so_far + SHIFT * (size % WIDTH)) % WIDTH;
        self.length += size as u64;
    }

    pub fn finish(&self) -> [u8; 20] {
        let mut out = [0u8; 20];
        out[0..8].copy_from_slice(&self.data[0].to_le_bytes());
        out[8..16].copy_from_slice(&self.data[1].to_le_bytes());
        out[16..20].copy_from_slice(&self.data[2].to_le_bytes()[..4]);
        for (i, b) in self.length.to_le_bytes().iter().enumerate() {
            out[WIDTH / 8 - 8 + i] ^= b;
        }
        out
    }

    /// As Graph writes it.
    pub fn finish_base64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.finish())
    }
}

/// Dropbox's `content_hash`: SHA-256 of each 4 MiB block, then SHA-256 of those digests one after
/// another, as lowercase hex.
pub struct DropboxHash {
    block: ring::digest::Context,
    in_block: usize,
    all: ring::digest::Context,
}

const BLOCK: usize = 4 * 1024 * 1024;

impl Default for DropboxHash {
    fn default() -> Self {
        Self::new()
    }
}

impl DropboxHash {
    pub fn new() -> Self {
        Self { block: ring::digest::Context::new(&ring::digest::SHA256), in_block: 0, all: ring::digest::Context::new(&ring::digest::SHA256) }
    }

    pub fn update(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            let take = (BLOCK - self.in_block).min(bytes.len());
            self.block.update(&bytes[..take]);
            self.in_block += take;
            bytes = &bytes[take..];
            if self.in_block == BLOCK {
                let done = std::mem::replace(&mut self.block, ring::digest::Context::new(&ring::digest::SHA256));
                self.all.update(done.finish().as_ref());
                self.in_block = 0;
            }
        }
    }

    pub fn finish(mut self) -> String {
        if self.in_block > 0 {
            self.all.update(self.block.finish().as_ref());
        }
        self.all.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The same bytes the vectors were made from (`rclone hashsum quickxor|dropbox`).
    fn pattern() -> Vec<u8> {
        (0..4 * 1024 * 1024 + 12345u32).map(|i| ((i as u64 * 7 + 3) % 251) as u8).collect()
    }
    fn small() -> Vec<u8> {
        (0..3).flat_map(|_| 0..=255u8).collect()
    }

    fn qx(data: &[u8], piece: usize) -> String {
        let mut h = QuickXor::new();
        for c in data.chunks(piece.max(1)) {
            h.update(c);
        }
        hex(&h.finish())
    }

    #[test]
    fn quickxor_matches_rclone() {
        assert_eq!(qx(b"", 1), "0000000000000000000000000000000000000000");
        assert_eq!(qx(b"hello world", 1024), "6828031bd8f00610dce10d726b03190000000000");
        assert_eq!(qx(&small(), 1024), "af100e19ed518a64c5fdefa4fe6d0ee679d2653f");
        let p = pattern();
        assert_eq!(qx(&p, 1 << 20), "c7a086e12d2c258098f6e0f6ded504cc85169003");
        // the result can't depend on how the bytes arrive
        assert_eq!(qx(&p, 7), "c7a086e12d2c258098f6e0f6ded504cc85169003");
        assert_eq!(qx(&small(), 161), "af100e19ed518a64c5fdefa4fe6d0ee679d2653f");
        let mut h = QuickXor::new();
        h.update(b"hello world");
        assert_eq!(h.finish_base64(), "aCgDG9jwBhDc4Q1yawMZAAAAAAA=");
    }

    fn dbx(data: &[u8], piece: usize) -> String {
        let mut h = DropboxHash::new();
        for c in data.chunks(piece.max(1)) {
            h.update(c);
        }
        h.finish()
    }

    #[test]
    fn dropbox_hash_matches_rclone() {
        assert_eq!(dbx(b"", 1), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(dbx(b"hello world", 3), "bc62d4b80d9e36da29c16c5d4d9f11731f36052c72401a76c23c0fb5a9b74423");
        assert_eq!(dbx(&small(), 100), "d0f910edaa00c9bb3420483c27c69fb9a503678a0fdcd684119d52432fd88657");
        let p = pattern();
        assert_eq!(dbx(&p, 1 << 20), "3fe4ed83f3eff3ded5067e8a11b299d0f01001c42e2e3954500231e9941a50ba");
        assert_eq!(dbx(&p, 999_999), "3fe4ed83f3eff3ded5067e8a11b299d0f01001c42e2e3954500231e9941a50ba");
    }
}
