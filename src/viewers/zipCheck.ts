/**
 * Zip bomb check for the Office previews (Word, Excel, PowerPoint, OpenDocument are zip files).
 * Their parsers inflate every part they touch into memory, some on the UI thread, and SheetJS even
 * allocates the size a part's header claims. The size caps in registry.ts are on the file as
 * downloaded; a few MB can inflate to many GB. Reading the directory first can't match every
 * parser, so the caps are enforced WHILE INFLATING: every part goes through JSZip's own stream,
 * which counts the bytes it produces and stops at the cap. The directory check below is only a
 * fast pre-filter. SheetJS, which unzips with its own code and reads other parts than JSZip does,
 * is only ever given a zip rebuilt from the bytes read here (see `plainForSheetJS`). Nothing here ever calls `.async()` on a part without a cap.
 */
import JSZip from "jszip";

/** Inflated size caps: any one part, and all parts together. */
export const PART_MAX = 128 * 1024 * 1024;
export const TOTAL_MAX = 256 * 1024 * 1024;

const EOCD = 0x06054b50;
const EOCD64_LOC = 0x07064b50;
const EOCD64 = 0x06064b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

type Part = { name: string; method: number; flags: number; csize: number; usize: number; local: number };

/** What reading an archive through the capped reader found. */
type Scan = { refused: string } | { plain: true } | { parts: [string, Uint8Array][] };

/** Why the archive may not be parsed (a short reason, for logs), or null when it may. */
export async function zipTooBig(bytes: Uint8Array, caps = { part: PART_MAX, total: TOTAL_MAX }): Promise<string | null> {
  const r = await scan(bytes, caps, false);
  return "refused" in r ? r.refused : null;
}

/**
 * The bytes to hand SheetJS (R8 S-1). SheetJS unzips with its own code and does NOT see the same
 * parts as JSZip: it inflates entries JSZip calls empty, directories and earlier duplicates, and
 * allocates the size a local header claims even when the directory and the data say otherwise. So
 * it never gets the uploaded zip. Every part is read through the capped reader (one budget for the
 * whole file) and a fresh, plain zip is written from exactly those bytes: STORE only, honest sizes,
 * no data descriptors, no comment, no extra fields, one entry per name, no directory entries.
 * Anything that isn't a zip (an old .xls, which is a compound file, or a CSV) comes back as it
 * was. A compound file has no compression, so what SheetJS reads from it can't be bigger than the
 * file itself, which the registry already caps (30 MB).
 */
export async function plainForSheetJS(bytes: Uint8Array, caps = { part: PART_MAX, total: TOTAL_MAX }): Promise<{ bytes: Uint8Array } | { refused: string }> {
  const r = await scan(bytes, caps, true);
  if ("refused" in r) return r;
  if ("plain" in r) return { bytes };
  const out = new JSZip();
  // a fixed date: the rebuilt zip is only ever read by SheetJS
  const date = new Date(Date.UTC(1980, 0, 1));
  for (const [name, data] of r.parts) out.file(name, data, { binary: true, compression: "STORE", createFolders: false, date });
  return { bytes: await out.generateAsync({ type: "uint8array", compression: "STORE" }) };
}

async function scan(bytes: Uint8Array, caps: { part: number; total: number }, keep: boolean): Promise<Scan> {
  let parts: Part[] | null;
  try {
    parts = directory(bytes);
  } catch {
    // a directory the parsers might read from another place than this check does (bytes in
    // front, a comment, a ZIP64 record only one reader uses): not worth the risk
    return { refused: "unusual zip layout" };
  }
  // not a zip at all (an old .xls, a CSV): nothing to inflate
  if (!parts) return { plain: true };
  const dv = view(bytes);
  let claimedTotal = 0;
  for (const p of parts) {
    // the size the directory or the part's own header claims (a fast refusal; what counts is the
    // inflating below, and SheetJS never sees these headers on the `keep` path)
    if (dv.getUint32(p.local, true) !== LOC) return { refused: "bad local header" };
    const localUsize = dv.getUint32(p.local + 22, true);
    const claimed = Math.max(p.usize, p.flags & 8 ? 0 : localUsize === 0xffffffff ? 0 : localUsize);
    if (claimed > caps.part) return { refused: `part too big: ${p.name}` };
    claimedTotal += claimed;
    if (claimedTotal > caps.total) return { refused: "inflates too far" };
    if (p.local + 30 + dv.getUint16(p.local + 26, true) + dv.getUint16(p.local + 28, true) + p.csize > bytes.length) return { refused: "part runs past the end" };
  }
  // the real count: every part inflated through JSZip's stream, stopped at the cap. A zip JSZip
  // can't read is refused too.
  try {
    const budget = { left: caps.total };
    const zip = await JSZip.loadAsync(bytes);
    const out: [string, Uint8Array][] = [];
    for (const f of Object.values(zip.files)) if (!f.dir) out.push([f.name, await readCapped(f, budget, caps.part, keep)]);
    return keep ? { parts: out } : { plain: true };
  } catch (e) {
    return { refused: e instanceof TooFar ? "inflates too far" : "unreadable zip" };
  }
}

class TooFar extends Error {}

/** What is left of the whole-file cap, shared by every part read from one archive. */
export type Budget = { left: number };

type Stream = { on(event: string, fn: (x: never) => void): Stream; pause(): void; resume(): void };

/**
 * One part's bytes, read through JSZip's stream so the output is counted as it is made: past
 * `partMax`, or past what is left in `budget`, it stops inflating and throws. `keep` false counts
 * and drops the bytes (the check pass). Never use `.async()` instead: it inflates without a limit.
 */
export function readCapped(file: JSZip.JSZipObject, budget: Budget, partMax = PART_MAX, keep = true): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const limit = Math.min(partMax, budget.left);
    const chunks: Uint8Array[] = [];
    let n = 0;
    let over = false;
    // JSZip has the streaming read in its code but not in its typings
    const stream = (file as unknown as { internalStream(t: "uint8array"): Stream }).internalStream("uint8array");
    stream
      .on("data", (c: Uint8Array) => {
        if (over) return;
        n += c.length;
        if (n > limit) {
          over = true;
          stream.pause();
          return reject(new TooFar("inflates too far"));
        }
        if (keep) chunks.push(c);
      })
      .on("error", (e: Error) => {
        if (!over) reject(e);
      })
      .on("end", () => {
        if (over) return;
        budget.left -= n;
        const out = new Uint8Array(keep ? n : 0);
        let at = 0;
        for (const c of chunks) (out.set(c, at), (at += c.length));
        resolve(out);
      });
    stream.resume();
  });
}

/** A zip opened for reading with every part capped (the part cap, and one budget for the whole). */
export type CappedZip = {
  has(name: string): boolean;
  names: string[];
  bytes(name: string): Promise<Uint8Array | undefined>;
  text(name: string): Promise<string | undefined>;
};

export async function openCapped(bytes: Uint8Array, caps = { part: PART_MAX, total: TOTAL_MAX }): Promise<CappedZip> {
  const zip = await JSZip.loadAsync(bytes);
  const budget = { left: caps.total };
  const bytesOf = async (name: string) => {
    const f = zip.file(name);
    return f ? readCapped(f, budget, caps.part) : undefined;
  };
  return {
    has: (name) => !!zip.file(name),
    names: Object.keys(zip.files),
    bytes: bytesOf,
    text: async (name) => {
      const b = await bytesOf(name);
      return b && new TextDecoder().decode(b);
    },
  };
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/**
 * The central directory's entries; null when there is no end-of-directory record (not a zip).
 * Throws unless the file is laid out the plain way every reader agrees on: nothing in front of
 * the first part, no zip comment, the directory ending exactly where the end record (or the ZIP64
 * record before it) starts, and no entries beyond the counted ones. JSZip, which the Word and
 * PowerPoint previews use, finds the end record from the back, shifts every offset by bytes in
 * front, goes to ZIP64 on more triggers than a size or an offset, and reads entries until the
 * signature stops. A file that only some of those rules fit would be read as another directory
 * than the one checked here (S-2).
 */
function directory(b: Uint8Array): Part[] | null {
  const dv = view(b);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    // JSZip looks for the end record from the back of the WHOLE file, so one further away than the
    // window above is still a zip to it (S-1): only a file with none anywhere is "not a zip"
    for (let i = b.length - 23 - 0xffff; i >= 0; i--) if (b[i] === 0x50 && dv.getUint32(i, true) === EOCD) throw new Error("end record far from the end");
    // starts like a zip but has no directory at all: refused rather than guessed at
    if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b) throw new Error("no directory");
    return null;
  }
  if (dv.getUint32(0, true) !== LOC) throw new Error("bytes before the first part");
  if (eocd + 22 !== b.length) throw new Error("zip comment or trailing bytes");
  let count = dv.getUint16(eocd + 10, true);
  let cdSize = dv.getUint32(eocd + 12, true);
  let cdOff = dv.getUint32(eocd + 16, true);
  // the same triggers JSZip uses for the ZIP64 record
  const wide = [4, 6, 8, 10].some((o) => dv.getUint16(eocd + o, true) === 0xffff) || cdSize === 0xffffffff || cdOff === 0xffffffff;
  const loc = eocd - 20;
  const located = loc >= 0 && dv.getUint32(loc, true) === EOCD64_LOC;
  let end = eocd;
  if (wide) {
    if (!located) throw new Error("zip64 locator");
    const at = num64(dv, loc + 8);
    if (at + 56 !== loc || dv.getUint32(at, true) !== EOCD64) throw new Error("zip64 record");
    count = num64(dv, at + 32);
    cdSize = num64(dv, at + 40);
    cdOff = num64(dv, at + 48);
    end = at;
  } else if (located) throw new Error("zip64 locator that is not used");
  if (cdOff + cdSize !== end) throw new Error("gap around the directory");
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
    // zip64: the real values sit in extra field 0x0001, in this order, for those marked 0xffffffff.
    // JSZip lets a repeated field overwrite the first and SheetJS reads it even without a marker
    // (S-2), so exactly one field, and only where a marker asks for it, counts as plain.
    const marked = usize === 0xffffffff || csize === 0xffffffff || local === 0xffffffff;
    let x = p + 46 + nameLen;
    const extraEnd = x + extraLen;
    let zip64 = 0;
    while (x + 4 <= extraEnd) {
      const id = dv.getUint16(x, true);
      const len = dv.getUint16(x + 2, true);
      if (id === 1) {
        zip64++;
        let q = x + 4;
        if (usize === 0xffffffff) (usize = num64(dv, q)), (q += 8);
        if (csize === 0xffffffff) (csize = num64(dv, q)), (q += 8);
        if (local === 0xffffffff) local = num64(dv, q);
      }
      x += 4 + len;
    }
    if (zip64 > 1 || (zip64 === 1 && !marked) || (marked && zip64 === 0)) throw new Error("zip64 extra field");
    parts.push({ name, method, flags, csize, usize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== end) throw new Error("directory entries left over");
  return parts;
}

/** A 64-bit little-endian size; anything past what a JS number holds exactly is "too big" anyway. */
const num64 = (dv: DataView, at: number) => dv.getUint32(at, true) + dv.getUint32(at + 4, true) * 2 ** 32;
