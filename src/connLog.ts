/**
 * Connecting, as the Activity log tells it: "Connecting to X…", "Connected to X (1.4 s)",
 * "Couldn't connect to X: X didn't answer in time." with the technical error under Details, and
 * folders that fail to list once connected. `watchConn` wraps the calls that open a connection
 * or a folder on screen (the sidebar's bucket list, a pane's listing); background work isn't
 * wrapped, so the log stays about what the user asked for.
 */
import { api, errMessage, LOCAL_ID } from "./api";
import { logMessage } from "./activityLog";
import { ARCHIVE_PREFIX } from "./archive/archive";
import { connectionName, rootName } from "./connections/roots";
import { classifyError, errorDetail, errorSentence, formatDuration } from "./logText.ts";
import { transfersActiveOn } from "./useTransfers";

/** A connection's name for the log ("this computer" for the built-in one). */
export function connLabel(profileId: string): string {
  if (profileId === LOCAL_ID) return "this computer";
  if (profileId.startsWith(ARCHIVE_PREFIX)) return "an archive";
  return connectionName(profileId) ?? "a connection";
}

/** What the log calls a root and folder: "“photos”", or the connection (bucket) itself. */
function folderLabel(profileId: string, root: string, prefix: string): string {
  const seg = prefix.replace(/\/+$/, "").split("/").pop();
  if (seg) return `“${seg}”`;
  const r = root === "" ? "" : rootName(profileId, root);
  return r ? `“${r}”` : "the top folder";
}

type ConnState = { state: "connecting" | "connected" | "failed"; since: number; attempt: number };
const states = new Map<string, ConnState>();
/** the last error line per connection, so a list that keeps failing the same way says it once a minute */
const lastError = new Map<string, { text: string; at: number }>();
let attempts = 0;

/** Ids the log leaves alone: this computer's disk and archives opened like folders never "connect". */
const quiet = (profileId: string) => profileId === LOCAL_ID || profileId.startsWith(ARCHIVE_PREFIX);

/**
 * Lines wait (in order) while a connection's name isn't known yet: at startup a pane can list
 * before the shell has handed the names over, and "Connecting to a connection…" helps nobody.
 */
const waiting: { profileId: string; say: () => void }[] = [];
let waitTries = 0;
function say(profileId: string, line: () => void) {
  if (!waiting.length && connectionName(profileId)) return line();
  waiting.push({ profileId, say: line });
  if (waiting.length === 1) {
    waitTries = 0;
    setTimeout(drain, 0);
  }
}
function drain() {
  if (waitTries++ < 20 && waiting.some((w) => !connectionName(w.profileId))) {
    setTimeout(drain, 100);
    return;
  }
  for (const w of waiting.splice(0)) w.say();
}

function logError(profileId: string, text: () => string, detail: () => string) {
  say(profileId, () => {
    const line = text();
    const prev = lastError.get(profileId);
    const now = Date.now();
    if (prev && prev.text === line && now - prev.at < 60_000) return;
    lastError.set(profileId, { text: line, at: now });
    logMessage("error", line, detail());
  });
}

/** The Details of a failed connect or listing: what failed, the hint, then the raw error. */
function detailOf(profileId: string, where: string | null, msg: string, ms: number): string {
  const { hint } = classifyError(msg);
  const lines = [`Connection: ${connLabel(profileId)}`];
  if (where) lines.push(`Folder: ${where}`);
  if (ms > 0) lines.push(`After: ${formatDuration(ms)}`);
  if (hint) lines.push(`What to do: ${hint}`);
  const raw = errorDetail(msg);
  lines.push("", `Error: ${errorSentence(msg)}`);
  if (raw) lines.push(raw);
  return lines.join("\n");
}

/**
 * Runs `run` (a call that needs the connection), noting in the log when this connects it, how
 * long that took, and when it fails. `loc`: the folder being listed (null: the connection's
 * buckets or roots).
 */
export async function watchConn<T>(profileId: string, loc: { root: string; prefix: string } | null, run: () => Promise<T>): Promise<T> {
  if (quiet(profileId)) return run();
  const name = () => connLabel(profileId);
  let st = states.get(profileId);
  if (!st || st.state === "failed") {
    st = { state: "connecting", since: Date.now(), attempt: ++attempts };
    states.set(profileId, st);
    say(profileId, () => logMessage("info", `Connecting to ${name()}…`));
  }
  const mine = st;
  const t0 = Date.now();
  try {
    const out = await run();
    const now = states.get(profileId);
    if (now === mine && mine.state === "connecting") {
      states.set(profileId, { state: "connected", since: Date.now(), attempt: mine.attempt });
      lastError.delete(profileId);
      const took = formatDuration(Date.now() - mine.since);
      say(profileId, () => logMessage("success", `Connected to ${name()} (${took})`));
    }
    return out;
  } catch (e) {
    const msg = errMessage(e);
    const cls = classifyError(msg);
    if (cls.kind === "cancelled") throw e;
    const where = loc ? `${loc.root ? `${rootName(profileId, loc.root)}/` : "/"}${loc.prefix}` : null;
    let now = states.get(profileId);
    // refused or missing, the server still answered: connected, only this failed
    if (now === mine && mine.state === "connecting" && (cls.kind === "denied" || cls.kind === "notfound")) {
      now = { state: "connected", since: Date.now(), attempt: mine.attempt };
      states.set(profileId, now);
      const took = formatDuration(Date.now() - mine.since);
      say(profileId, () => logMessage("success", `Connected to ${name()} (${took})`));
    }
    if (now === mine && mine.state === "connecting") {
      // the first answer of this attempt decides it; a second call of the same attempt failing
      // the same way says nothing more
      states.set(profileId, { state: "failed", since: Date.now(), attempt: mine.attempt });
      const ms = Date.now() - t0;
      logError(profileId, () => `Couldn't connect to ${name()}: ${errorSentence(msg)}`, () => detailOf(profileId, where, msg, ms));
    } else if (now?.state === "connected" || !now) {
      const ms = Date.now() - t0;
      const what = () => (loc ? `Couldn't open ${folderLabel(profileId, loc.root, loc.prefix)} on ${name()}` : `Couldn't list ${name()}`);
      logError(profileId, () => `${what()}: ${errorSentence(msg)}`, () => detailOf(profileId, where, msg, ms));
      // the connection itself is gone (a timeout, the VPN dropped): the next success connects again
      if (cls.network) states.set(profileId, { state: "failed", since: Date.now(), attempt: now?.attempt ?? ++attempts });
    }
    throw e;
  }
}

/**
 * Before "Try again": lets go of the connection's open backend, so the next call really connects
 * afresh (new sockets after the VPN came up), unless transfers of it are still running (they'd
 * lose nothing, but the server would get a second set of connections).
 */
export async function freshConnection(profileId: string): Promise<void> {
  if (quiet(profileId) || transfersActiveOn(profileId)) return;
  states.delete(profileId);
  lastError.delete(profileId);
  await api.reconnect(profileId).catch(() => {});
}

/** The plain hint for an error shown on screen ("The server didn't answer…"), or null. */
export function errorHint(msg: string | null | undefined): string | null {
  return classifyError(msg).hint;
}
