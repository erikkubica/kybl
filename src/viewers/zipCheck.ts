/**
 * Zip bomb check for the Office previews (Word, Excel, PowerPoint, OpenDocument are zip files).
 * Their parsers inflate every part they touch into memory, some on the UI thread, and SheetJS even
 * allocates the size a part's header claims. The size caps in registry.ts are on the file as
 * downloaded; a few MB can inflate to many GB. So before parsing, the zip's directory is read and
 * each part is inflated once as a stream, counting bytes and keeping none: a part, or the whole,
 * past the caps below is refused, whatever its headers say.
 */

/** Inflated size caps: any one part, and all parts together. */
export const PART_MAX = 128 * 1024 * 1024;
export const TOTAL_MAX = 256 * 1024 * 1024;

const EOCD = 0x06054b50;
const EOCD64_LOC = 0x07064b50;
const EOCD64 = 0x06064b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

type Part = { name: string; method: number; flags: number; csize: number; usize: number; local: number };

/** Why the archive may not be parsed (a short reason, for logs), or null when it may. */
export async function zipTooBig(bytes: Uint8Array, caps = { part: PART_MAX, total: TOTAL_MAX }): Promise<string | null> {
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  let parts: Part[] | null;
  try {
    parts = directory(bytes);
  } catch {
    parts = null;
  }
  // not a zip at all (an old .xls, a CSV): nothing to inflate
  if (!parts) return isZip ? "unreadable zip directory" : null;
  const dv = view(bytes);
  let total = 0;
  for (const p of parts) {
    // the size the directory or the part's own header claims (a parser may trust either)
    if (dv.getUint32(p.local, true) !== LOC) return "bad local header";
    const localUsize = dv.getUint32(p.local + 22, true);
    const claimed = Math.max(p.usize, p.flags & 8 ? 0 : localUsize === 0xffffffff ? 0 : localUsize);
    if (claimed > caps.part) return `part too big: ${p.name}`;
    const start = p.local + 30 + dv.getUint16(p.local + 26, true) + dv.getUint16(p.local + 28, true);
    if (start + p.csize > bytes.length) return "part runs past the end";
    let size: number;
    if (p.method === 0) size = p.csize;
    else if (p.method === 8) {
      const left = Math.min(caps.part, caps.total - total);
      const n = await inflatedSize(bytes.subarray(start, start + p.csize), left);
      if (n == null) continue; // this web view can't inflate: the claimed sizes were all there was to check
      if (n > left) return `part inflates too far: ${p.name}`;
      size = n;
    } else continue; // a method the parsers don't read either
    total += Math.max(size, claimed);
    if (total > caps.total) return "inflates too far";
  }
  return null;
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** The central directory's entries; null when there is no end-of-directory record (not a zip). */
function directory(b: Uint8Array): Part[] | null {
  const dv = view(b);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  let count = dv.getUint16(eocd + 10, true);
  let cdOff = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOff === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || dv.getUint32(loc, true) !== EOCD64_LOC) throw new Error("zip64 locator");
    const at = num64(dv, loc + 8);
    if (dv.getUint32(at, true) !== EOCD64) throw new Error("zip64 record");
    count = num64(dv, at + 32);
    cdOff = num64(dv, at + 48);
  }
  const parts: Part[] = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== CEN) throw new Error("directory entry");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    let csize = dv.getUint32(p + 20, true);
    let usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    // zip64: the real values sit in extra field 0x0001, in this order, for those marked 0xffffffff
    if (usize === 0xffffffff || csize === 0xffffffff || local === 0xffffffff) {
      let x = p + 46 + nameLen;
      const end = x + extraLen;
      while (x + 4 <= end) {
        const id = dv.getUint16(x, true);
        const len = dv.getUint16(x + 2, true);
        if (id === 1) {
          let q = x + 4;
          if (usize === 0xffffffff) (usize = num64(dv, q)), (q += 8);
          if (csize === 0xffffffff) (csize = num64(dv, q)), (q += 8);
          if (local === 0xffffffff) local = num64(dv, q);
          break;
        }
        x += 4 + len;
      }
    }
    parts.push({ name, method, flags, csize, usize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return parts;
}

/** A 64-bit little-endian size; anything past what a JS number holds exactly is "too big" anyway. */
const num64 = (dv: DataView, at: number) => dv.getUint32(at, true) + dv.getUint32(at + 4, true) * 2 ** 32;

/**
 * How many bytes `deflated` inflates to, counted as it streams (nothing kept); stops once past
 * `limit` and returns a number above it. Null when the web view has no raw-deflate stream.
 */
async function inflatedSize(deflated: Uint8Array, limit: number): Promise<number | null> {
  let ds: DecompressionStream;
  try {
    ds = new DecompressionStream("deflate-raw");
  } catch {
    return null;
  }
  const writer = ds.writable.getWriter();
  // fed in pieces, so a stop doesn't wait for the whole part to be written
  void (async () => {
    try {
      for (let i = 0; i < deflated.length; i += 1 << 20) await writer.write(deflated.subarray(i, i + (1 << 20)) as Uint8Array<ArrayBuffer>);
      await writer.close();
    } catch {
      /* cancelled, or bad data: the reader sees it */
    }
  })();
  const reader = ds.readable.getReader();
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return n;
      n += value.byteLength;
      if (n > limit) {
        void reader.cancel().catch(() => {});
        return n;
      }
    }
  } catch {
    // damaged data: the parser will say so itself; what came out so far is what counts
    return n;
  }
}
