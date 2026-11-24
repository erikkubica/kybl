/**
 * The words of the Activity log (src/activityLog.ts): what a transfer, a connection or an error
 * says there, and what is taken out of it first (passwords, tokens, keys, signed URLs). Pure, so
 * `pnpm test` covers it (tests/logText.test.ts).
 */
import { formatBytes } from "./format.ts";

// ---------------------------------------------------------------- secrets

const HIDDEN = "•••";
/** query parameters that carry a credential or a signature (presigned S3 URLs, SAS, OAuth) */
const SECRET_PARAMS =
  /([?&;](?:x-amz-(?:signature|credential|security-token)|signature|sig|token|access_token|refresh_token|id_token|client_secret|password|passwd|pwd|secret|api_?key|key|code|se|sv|sp|skoid|sktid|skt|ske|sks|skv|tempauth|upload_?id|x-goog-[a-z-]+|sharedaccesssignature|access_?key|auth)=)[^&#\s"'<>]+/gi;

/** Names that hold a credential when they appear anywhere in the name (`secretKey`, `X-Amz-Security-Token`, `auth_key`). */
const CRED_WORDS = "secret|passw(?:or)?d|pwd|passphrase|token|account[_-]?key|access[_-]?key|api[_-]?key|private[_-]?key|credential|auth[_-]?key|session[_-]?(?:id|key)";
/** Words too short to match inside other names (`monkey`, `hotplug`): only a whole name counts. */
const CRED_WHOLE = "pass|pw|pswd|sid|jwt|otp|key|session|authkey";
/**
 * `name = value`, `"name": "value"`, `\"name\":\"value\"` (JSON inside a string). The name scan starts at the
 * credential word and reaches at most 80 name characters after it, so a long name is still found and a long
 * run of letters stays linear. A quoted value runs to its closing quote (spaces, commas and `&` in it are part
 * of it, so is a missing end quote: to the end of the line); a bare one runs to the next whitespace, except
 * in a URL query (`?a=b&c=d`), where `&` starts the next parameter.
 */
function namedValue(inQuery: boolean) {
  const q = String.raw`(?:\\?["'])?[ \t]*[:=][ \t]*`;
  // in a query the scan starts at the `?`, `&` or `;` (not at every letter), so it stays cheap
  const name = inQuery
    ? String.raw`[?&;][\w-]{0,80}?(?:(?:${CRED_WORDS})[\w-]{0,80}|(?:${CRED_WHOLE}))${q}`
    : String.raw`(?:${CRED_WORDS})[\w-]{0,80}${q}|(?<![\w-])(?:${CRED_WHOLE})${q}`;
  // a value already hidden by an earlier rule is left alone, so `•••&x=1` is not read as one long value
  const bare = inQuery ? String.raw`[^\s&#"'<>]+` : String.raw`(?!•••)[^\s"'][^\s]*`;
  return new RegExp(String.raw`(${name})(?:(\\")((?:(?!\\")[^\n])*)|(")((?:\\.|[^"\\\n])*)|(')([^'\n]*)|${bare})`, "gi");
}
const QUERY_VALUE = namedValue(true);
const NAMED_VALUE = namedValue(false);
const hideValue = (_m: string, head: string, q1?: string, _v1?: string, q2?: string, _v2?: string, q3?: string) => `${head}${q1 ?? q2 ?? q3 ?? ""}${HIDDEN}`;

/**
 * Takes credentials out of text bound for the log: user:password in URLs, signed URL parameters,
 * Authorization headers, `password=…`-style pairs and private key blocks.
 */
export function redact(text: string): string {
  return (
    text
      // PEM blocks first: their body has no spaces the other rules could stop at
      .replace(/-----BEGIN [A-Z0-9 ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/gi, "[private key removed]")
      // scheme://user:password@host (and scheme://token@host); the scheme is capped so a long
      // run of dots and letters can't make the scan quadratic (S-6)
      .replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@"'<>]+@/gi, `$1${HIDDEN}@`)
      .replace(SECRET_PARAMS, `$1${HIDDEN}`)
      // the signature of an AWS `Authorization: AWS4-HMAC-SHA256 Credential=…, Signature=…` header
      .replace(/\b(signature=)[^\s,&"']+/gi, `$1${HIDDEN}`)
      // cookies and session headers, to the end of the line
      .replace(/\b((?:set-)?cookie|x-auth-token)(\s*:\s*)[^\r\n]+/gi, `$1$2${HIDDEN}`)
      // JSON tokens: {"token":"…"}, "id_token", "SessionToken"
      .replace(/("(?:token|id_?token|session_?token)"\s*:\s*")[^"]*/gi, `$1${HIDDEN}`)
      // environment style names: AWS_SECRET_ACCESS_KEY=…
      .replace(/\b([A-Z0-9_]{0,60}SECRET[A-Z0-9_]{0,60}=)[^\s"',;&]+/g, `$1${HIDDEN}`)
      // the per-run trust tag the app puts into host key and certificate errors
      .replace(/\bkybl:[0-9a-f]{32}\b ?/g, "")
      // the whole value to the end of the line: schemes such as `SharedKey acct:SIGNATURE` or `Token abc` have more than one word
      .replace(/\b(authorization\s*[:=]\s*)(?:(bearer|basic|aws4-hmac-sha256)\s+)?[^\r\n]+/gi, (_m, head: string, scheme?: string) => `${head}${scheme ? `${scheme} ` : ""}${HIDDEN}`)
      .replace(/\b(bearer|basic)\s+[a-z0-9._~+/=-]{8,}/gi, `$1 ${HIDDEN}`)
      // any name that has a credential word in it, whatever comes before or after (`aws_secret_access_key = …`,
      // `AccountKey=…`, `X-Amz-Security-Token: …`, `?auth_token=…`): by the shape of the name, not a list
      .replace(QUERY_VALUE, hideValue)
      .replace(NAMED_VALUE, hideValue)
      // a command line flag with its value after a space, and the FTP PASS command
      .replace(/(?<![\w-])(--?(?:password|passwd|pwd|passphrase|secret|token|pass|pw)[ \t]+)(?!-)\S+/gi, `$1${HIDDEN}`)
      .replace(/\b(PASS[ \t]+)\S+/g, `$1${HIDDEN}`)
  );
}

// ---------------------------------------------------------------- errors

export type ErrorClass = "timeout" | "refused" | "dns" | "offline" | "auth" | "cert" | "hostkey" | "denied" | "notfound" | "cancelled" | "other";

/** What kind of trouble an error is, and a short plain hint for what to do about it (null: the message says it). */
export function classifyError(msg: string | null | undefined): { kind: ErrorClass; hint: string | null; network: boolean } {
  const m = msg ?? "";
  const is = (re: RegExp) => re.test(m);
  if (/^cancell?ed$/i.test(m.trim())) return { kind: "cancelled", hint: null, network: false };
  if (is(/certificate|unknown ?issuer|self[- ]signed/i)) return { kind: "cert", hint: null, network: false };
  if (is(/host ?key|server's key|server’s key|not seen before|key has changed|fingerprint/i)) return { kind: "hostkey", hint: null, network: false };
  if (is(/didn['’]t answer|timed? ?out|timeout|deadline (has )?elapsed|took too long/i))
    return { kind: "timeout", hint: "The server didn't answer. Check your network or VPN, then try again.", network: true };
  if (is(/refused the connection|connection refused|econnrefused/i))
    return { kind: "refused", hint: "The server turned the connection away. Check the port, and that the server is running.", network: true };
  if (is(/couldn['’]t find \S+\. check the address|failed to lookup|nodename nor servname|name or service not known|no such host|dns error|enotfound/i))
    return { kind: "dns", hint: "The server's name couldn't be found. Check the address, or your network or VPN.", network: true };
  if (
    is(/couldn['’]t reach|network is unreachable|no route to host|connection (was )?(reset|closed|aborted)|connection to the server dropped|broken pipe|dispatch failure|error sending request|not connected to the internet|offline|unexpected eof/i)
  )
    return { kind: "offline", hint: "Couldn't reach the server. Check your network or VPN, then try again.", network: true };
  if (is(/wrong user name or password|login incorrect|authenticat|sign in again|no longer signed in|invalid_grant|expired or revoked|didn['’]t accept|key was refused|invalidaccesskeyid|signaturedoesnotmatch|\b(401|530)\b/i))
    return { kind: "auth", hint: "The sign-in was turned down. Check the user name, password or key in the connection's settings.", network: false };
  if (is(/access denied|permission denied|not allowed|forbidden|\b403\b/i)) return { kind: "denied", hint: null, network: false };
  if (is(/not found|no such file|doesn['’]t exist|isn['’]t there|nosuchkey|nosuchbucket|\b404\b/i)) return { kind: "notfound", hint: null, network: false };
  return { kind: "other", hint: null, network: false };
}

/** Errors from the backend come as "sentence\n\ndetail": the sentence. */
export function errorSentence(msg: string): string {
  const i = msg.indexOf("\n\n");
  return (i < 0 ? msg : msg.slice(0, i)).trim();
}

/** The technical part of a backend error ("sentence\n\ndetail"), without the per-run trust tag. */
export function errorDetail(msg: string): string | null {
  const i = msg.indexOf("\n\n");
  return i < 0 ? null : msg.slice(i + 2).replace(/^kybl:[0-9a-f]{32} /, "").trim() || null;
}

// ---------------------------------------------------------------- times

/** "0.4 s", "12 s", "1 min 12 s", "2 h 5 min": how long something took. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 10_000) return `${(Math.max(ms, 100) / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** "14:03:22" for the log and for copied text. */
export function clockTime(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

// ---------------------------------------------------------------- transfers

export type TransferKind = "upload" | "download" | "compress" | "extract";

/** The last part of a path ("/Users/me/Downloads" → "Downloads"; "a/b/" → "b"). */
export function lastSegment(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * What a batch is about, from its rows' names (paths below where it lands): the one file, the
 * one folder ("regina-lite" for "regina-lite/a.txt" and "regina-lite/b/c.txt"), or the first and
 * how many more.
 */
export function batchSubject(names: string[]): string {
  const tops = new Map<string, boolean>();
  for (const n of names) {
    const clean = n.replace(/\\/g, "/").replace(/^\/+/, "");
    const cut = clean.indexOf("/");
    const top = cut < 0 ? clean : clean.slice(0, cut);
    if (!top) continue;
    tops.set(top, (tops.get(top) ?? false) || cut >= 0);
  }
  const list = [...tops];
  if (!list.length) return names.length === 1 ? "1 file" : `${names.length.toLocaleString()} files`;
  const [first, folder] = list[0];
  const one = `“${first}”${folder ? " (folder)" : ""}`;
  return list.length === 1 ? one : `${one} and ${(list.length - 1).toLocaleString()} more`;
}

export type BatchInfo = {
  kind: TransferKind;
  /** from `batchSubject`, or the archive's name for compress / extract */
  subject: string;
  /** the connection's name */
  conn: string;
  /** downloads: the local folder's name ("Downloads"); uploads: the remote folder's (or ""), others: "" */
  place: string;
  /** a temporary copy (to open or preview a file), not a download the user keeps */
  temp?: boolean;
  /** started again with Retry */
  retry?: boolean;
};

export type BatchEnd = BatchInfo & {
  count: number;
  done: number;
  failed: number;
  cancelled: number;
  bytes: number;
  ms: number;
  /** the first errors: which file, and why */
  errors: { name: string; message: string }[];
};

const VERBS: Record<TransferKind, { ing: string; ed: string; base: string; ingCap: string }> = {
  download: { ing: "downloading", ingCap: "Downloading", ed: "Downloaded", base: "download" },
  upload: { ing: "uploading", ingCap: "Uploading", ed: "Uploaded", base: "upload" },
  compress: { ing: "compressing", ingCap: "Compressing", ed: "Compressed", base: "compress" },
  extract: { ing: "extracting", ingCap: "Extracting", ed: "Extracted", base: "extract" },
};

/** "from X to Downloads", "to “photos” on X", "on X" */
function where(b: BatchInfo): string {
  if (b.kind === "download") return b.temp ? `from ${b.conn} to open it` : `from ${b.conn}${b.place ? ` to ${b.place}` : ""}`;
  if (b.kind === "upload") return b.place ? `to “${b.place}” on ${b.conn}` : `to ${b.conn}`;
  return `on ${b.conn}`;
}

/** The log line when a batch starts: "Started downloading “regina-lite” (folder) from X to Downloads". */
export function batchStartLine(b: BatchInfo): string {
  const v = VERBS[b.kind];
  const what = b.kind === "compress" ? `into ${b.subject}` : b.subject;
  return `${b.retry ? "Trying again:" : "Started"} ${v.ing} ${what} ${where(b)}`;
}

const files = (n: number) => `${n.toLocaleString()} ${n === 1 ? "file" : "files"}`;

/** The log line when every row of a batch has ended: done (counts, size, time), failed (why) or stopped. */
export function batchEndLine(b: BatchEnd): { kind: "success" | "error" | "info"; text: string } {
  const v = VERBS[b.kind];
  const what = b.kind === "compress" ? `into ${b.subject}` : b.subject;
  const took = formatDuration(b.ms);
  const sized = b.bytes > 0 ? `, ${formatBytes(b.bytes)}` : "";
  const perFile = b.kind === "download" || b.kind === "upload";
  const firstErr = b.errors[0] ? errorSentence(b.errors[0].message) : "";
  if (b.failed === 0 && b.done === 0) return { kind: "info", text: `Stopped ${v.ing} ${what} ${where(b)}` };
  if (b.failed === 0) {
    const counts = perFile ? ` (${files(b.done)}${sized}${b.cancelled ? `, ${b.cancelled.toLocaleString()} stopped` : ""})` : sized ? ` (${sized.slice(2)})` : "";
    return { kind: "success", text: `${v.ed} ${what} ${where(b)}${counts}${took ? ` in ${took}` : ""}` };
  }
  if (b.done === 0) return { kind: "error", text: `Couldn't ${v.base} ${what} ${where(b)}${firstErr ? `: ${firstErr}` : ""}` };
  return {
    kind: "error",
    text: `${v.ingCap} ${what} ${where(b)} finished with problems: ${b.failed.toLocaleString()} of ${files(b.count)} failed${firstErr ? ` (${firstErr})` : ""}`,
  };
}

/** The "Details" of a batch's line: where exactly, counts, time and the first errors in full. */
export function batchDetail(b: BatchEnd | BatchInfo, facts: [string, string | null | undefined][]): string {
  const lines = facts.filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}: ${v}`);
  if ("count" in b) {
    lines.push(`Files: ${b.count.toLocaleString()} (${b.done.toLocaleString()} done${b.failed ? `, ${b.failed.toLocaleString()} failed` : ""}${b.cancelled ? `, ${b.cancelled.toLocaleString()} stopped` : ""})`);
    if (b.bytes > 0) lines.push(`Size: ${formatBytes(b.bytes)}`);
    if (b.ms > 0) lines.push(`Took: ${formatDuration(b.ms)}`);
    if (b.errors.length) {
      lines.push("", b.failed > b.errors.length ? `Errors (the first ${b.errors.length} of ${b.failed.toLocaleString()}):` : "Errors:");
      for (const e of b.errors) lines.push(`• ${`${e.name}: ${e.message}`.replace(/\n\n/g, " — ").replace(/\n/g, " ")}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- copying the log

/** The log as plain text, for "Copy log": one line per entry, its details indented below. */
export function logAsText(entries: { at: number; kind: string; text: string; detail?: string | null }[]): string {
  return entries
    .map((e) => {
      const head = `${clockTime(e.at)}  ${e.kind === "error" ? "ERROR " : e.kind === "success" ? "OK    " : "      "}${e.text}`;
      return e.detail ? `${head}\n${e.detail.replace(/^/gm, "        ")}` : head;
    })
    .join("\n");
}
