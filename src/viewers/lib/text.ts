/**
 * Bytes to editable text and back, without changing anything the person didn't touch: the byte
 * order mark, the encoding and the line endings come back exactly as they were.
 */

export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";
export type Eol = "\n" | "\r\n" | "\r";

export type TextDoc = {
  text: string;
  encoding: Encoding;
  /** the file started with a byte order mark */
  bom: boolean;
  /** the most common line ending, used for every line on save */
  eol: Eol;
  /** set when the text could only be shown approximately: such files open read-only */
  lossy: boolean;
};

export function decodeText(bytes: Uint8Array): TextDoc {
  let encoding: Encoding = "utf-8";
  let bom = false;
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bom = true;
    start = 3;
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    bom = true;
    start = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    bom = true;
    start = 2;
  }
  const body = bytes.subarray(start);
  let text: string;
  let lossy = false;
  try {
    // fatal: one invalid byte means this isn't UTF-8 (or UTF-16), and saving it back as such
    // would corrupt it
    text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    // shown as Windows-1252 (every byte maps to something), read-only
    encoding = "windows-1252";
    lossy = true;
    text = new TextDecoder("windows-1252").decode(body);
  }
  if (!lossy && text.includes("\u0000") && encoding === "utf-8") {
    // NUL bytes: binary data that happens to be valid UTF-8; editing it would be a bad idea
    lossy = true;
  }
  return { text, encoding, bom, eol: detectEol(text), lossy };
}

export function detectEol(text: string): Eol {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  // the first megabyte is plenty to tell
  const end = Math.min(text.length, 1_000_000);
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  if (crlf > lf && crlf >= cr) return "\r\n";
  if (cr > lf && cr > crlf) return "\r";
  return "\n";
}

/**
 * The editor's text (lines joined with "\n", as CodeMirror hands it out) back to bytes in the
 * file's own encoding, BOM and line endings.
 */
export function encodeText(text: string, like: Pick<TextDoc, "encoding" | "bom" | "eol">): Uint8Array {
  const body = like.eol === "\n" ? text : text.replace(/\r\n|\r|\n/g, like.eol);
  if (like.encoding === "utf-16le" || like.encoding === "utf-16be") {
    const le = like.encoding === "utf-16le";
    const off = like.bom ? 2 : 0;
    const out = new Uint8Array(off + body.length * 2);
    if (like.bom) {
      out[0] = le ? 0xff : 0xfe;
      out[1] = le ? 0xfe : 0xff;
    }
    for (let i = 0; i < body.length; i++) {
      const c = body.charCodeAt(i);
      out[off + i * 2] = le ? c & 0xff : c >> 8;
      out[off + i * 2 + 1] = le ? c >> 8 : c & 0xff;
    }
    return out;
  }
  // windows-1252 files are read-only, so everything saved is UTF-8
  const utf8 = new TextEncoder().encode(body);
  if (!like.bom) return utf8;
  const out = new Uint8Array(utf8.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(utf8, 3);
  return out;
}
