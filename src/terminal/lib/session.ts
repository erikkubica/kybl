/**
 * Running terminals (lazy chunk): one xterm.js terminal and one backend shell per session, kept
 * outside React so a pane can come and go (a workspace switch, a move to another workspace) while
 * the shell runs on and keeps its scrollback. A pane attaches the session's element when it shows
 * and detaches it when it doesn't.
 *
 * Output arrives on a Tauri Channel as raw bytes, batched by the backend; each batch is acknowledged
 * once xterm.js has taken it in (flow control: the backend pauses a program that writes faster
 * than the page draws). Nothing typed or shown is logged.
 */
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Channel, invoke } from "@tauri-apps/api/core";
import { LS } from "../../browser/types";
import { openLink } from "../../core/openLink";
import { IS_MAC } from "../../ui/lib/pointer";
import { confirmPaste, pasteTrusts, setPasteTrust, setTermImpl, takeFocusWhenShown, takeStartup, termNotice, termWriteWhy, terminalShell, type TermAction, type TermSpec, type TermWrite } from "../api";
import { cleanPaste, PASTE_ASK_ALWAYS, PASTE_MAX, pasteNeedsConfirm, type Quoting } from "./quote";

const SCROLLBACK = 5000;
const FONT_KEY = "s3b.term.font";
const FONT_DEFAULT = 12;
const FONT_MIN = 9;
const FONT_MAX = 24;
/** acknowledged in steps this big (or after a short pause), not per batch */
const ACK_STEP = 64 * 1024;

type Info = { id: number; remoteBase: string | null; quoting?: Quoting | null };
type Msg = ArrayBuffer | { exit: number | null };

const MAC = /Mac/i.test(navigator.platform || navigator.userAgent);
/** a prompt's end, right before the cursor (see Session.idle) */
const PROMPT_REMOTE = /[$%#] $/;
// (Command Prompt: `C:\Users\me>`, no space after)
const PROMPT_LOCAL = /(?:[$%#>❯] |^[A-Za-z]:\\[^>]*>)$/;
/** ms after a key is typed before the line counts as known (its echo has come back) */
const TYPED_LATELY = 500;
/** Typeahead kept while a shell starts (a few lines of keys; more is dropped). */
const TYPEAHEAD_MAX = 4096;
/** Pasted (or dropped) text kept while a shell starts. */
const PASTE_QUEUE_MAX = PASTE_ASK_ALWAYS;

let fontSize = clampFont(Number(LS.get(FONT_KEY)) || FONT_DEFAULT);
function clampFont(n: number) {
  return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
}

/** The terminal's colours from the app's theme: its background, text and accent, and ANSI colours readable on it. */
function theme(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  const dark = document.documentElement.dataset.theme === "dark";
  const ansi = dark
    ? {
        black: "#3a3c44", red: "#ff7b6e", green: "#4cd487", yellow: "#e6b455", blue: "#7aa2ff", magenta: "#c49bff", cyan: "#5fd4d0", white: "#d4d5dc",
        brightBlack: "#6b6e7a", brightRed: "#ff9d93", brightGreen: "#7fe3a8", brightYellow: "#f2cb7c", brightBlue: "#a2bfff", brightMagenta: "#d9bdff", brightCyan: "#8ce4e1", brightWhite: "#ffffff",
      }
    : {
        black: "#17181c", red: "#c4321f", green: "#17803d", yellow: "#946100", blue: "#2c5fd6", magenta: "#8e3fb5", cyan: "#0f7d7a", white: "#a8abb5",
        brightBlack: "#60636e", brightRed: "#dc3a28", brightGreen: "#1f9a4b", brightYellow: "#b7791f", brightBlue: "#3d78f6", brightMagenta: "#a855d6", brightCyan: "#12a594", brightWhite: "#6b6e7a",
      };
  return {
    background: v("--bg") || (dark ? "#17181b" : "#ffffff"),
    foreground: v("--text") || (dark ? "#ececf1" : "#17181c"),
    cursor: v("--accent") || "#2c6bf2",
    cursorAccent: v("--bg") || "#ffffff",
    selectionBackground: v("--accent-ring") || "rgba(44,107,242,.28)",
    scrollbarSliderBackground: dark ? "rgba(255,255,255,.14)" : "rgba(18,22,40,.16)",
    scrollbarSliderHoverBackground: dark ? "rgba(255,255,255,.24)" : "rgba(18,22,40,.26)",
    scrollbarSliderActiveBackground: dark ? "rgba(255,255,255,.3)" : "rgba(18,22,40,.32)",
    ...ansi,
  };
}
const monoFont = () => getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "ui-monospace, Menlo, monospace";

class Session {
  readonly term: Terminal;
  readonly host: HTMLDivElement;
  private readonly fit = new FitAddon();
  private id: number | null = null;
  /** which start this is: messages of a shell that was restarted are dropped */
  private run = 0;
  private state: "idle" | "starting" | "running" | "ended" = "idle";
  private unacked = 0;
  private ackTimer = 0;
  remoteBase: string | null = null;
  /** how the shell on this computer wants paths typed */
  quoting: Quoting | null = null;
  private opened = false;
  /** when a key was last typed (its echo may not be on screen yet) */
  private lastInput = 0;
  /** Keys typed and text pasted while the shell starts, in order, sent once it runs (terminals keep typeahead). */
  private pending: { text: string; paste: boolean }[] = [];
  private queuedKeys = 0;
  private queuedPaste = 0;

  constructor(readonly spec: TermSpec) {
    this.host = document.createElement("div");
    this.host.className = "term-host";
    this.term = new Terminal({
      scrollback: SCROLLBACK,
      fontFamily: monoFont(),
      fontSize,
      lineHeight: 1.15,
      cursorBlink: true,
      allowProposedApi: false,
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: MAC,
      theme: theme(),
      // links the server prints (OSC 8) open in the system browser, never in a window of the app, and
      // only on a deliberate ⌘/Ctrl-click: a plain click just focuses the terminal, and the real
      // address is shown first since the text it hides can say anything
      linkHandler: {
        activate: (e, uri) => {
          if (!(e.metaKey || e.ctrlKey)) return termNotice(`${MAC ? "⌘" : "Ctrl"}-click opens ${uri}`);
          void openLink(uri).catch(() => termNotice("That link can't be opened."));
        },
        // the address as a tooltip (a notice per hovered link would fill the bell)
        hover: (_e, uri) => {
          this.host.title = `${MAC ? "⌘" : "Ctrl"}-click opens ${uri}`;
        },
        leave: () => {
          this.host.title = "";
        },
      },
    });
    this.term.loadAddon(this.fit);
    this.term.onData((d) => this.input(d, false));
    this.term.onBinary((d) => this.input(d, true));
    this.term.onResize(({ cols, rows }) => {
      if (this.id != null) void invoke("terminal_resize", { id: this.id, cols, rows }).catch(() => {});
    });
    // the app's own keys: xterm.js leaves them alone (handled on the pane, see TermView). ⌃Tab /
    // ⌃⇧Tab switch workspaces: xterm would send a Tab and cancel the event, so it never reached the
    // app's window listener; returning false lets the event bubble on untouched.
    this.term.attachCustomKeyEventHandler((e) => !ownKey(e) && !passKey(e));
    // ⌘V and the system Edit menu paste through xterm's own textarea: taken over here (capture,
    // before xterm sees it) so clipboard text loses its control characters first
    this.host.addEventListener(
      "paste",
      (e) => {
        const t = e.clipboardData?.getData("text/plain");
        e.preventDefault();
        e.stopPropagation();
        if (t) void this.pasteText(t);
      },
      true,
    );
  }

  /** Clipboard text into the shell: control characters gone, and a yes first when its lines would run at once. */
  private async pasteText(t: string) {
    if (t.length > PASTE_MAX) return termNotice("That’s too much text to paste into a terminal.");
    const text = cleanPaste(t);
    if (!text) return;
    const why = this.state === "running" || this.state === "starting" ? null : termWriteWhy(this.state === "ended" ? "ended" : "none");
    if (why) return termNotice(why);
    // the flag only counts for a shell that is running now (a new one starts without it)
    const bracketed = this.state === "running" && this.term.modes.bracketedPasteMode;
    const sid = this.spec.sid;
    if (pasteNeedsConfirm(text, bracketed, pasteTrusts(sid))) {
      const run = this.run;
      const canTrust = bracketed && text.length <= PASTE_ASK_ALWAYS;
      const a = await confirmPaste({ text, canTrust });
      if (!a.ok) return;
      if (run !== this.run) return termNotice("That terminal restarted, so nothing was pasted.");
      if (a.trust && canTrust) setPasteTrust(sid, true);
      this.term.focus();
    }
    const after = termWriteWhy(this.deliver(text, true));
    if (after) termNotice(after);
  }

  /** Text to the shell, pasted or as keys; kept in order while it starts. */
  private deliver(text: string, paste: boolean): TermWrite {
    if (this.state === "running") {
      if (paste) this.term.paste(text);
      else this.send(text);
      return "typed";
    }
    if (this.state === "starting") {
      if (paste ? this.queuedPaste + text.length > PASTE_QUEUE_MAX : this.queuedKeys + text.length > TYPEAHEAD_MAX) return "full";
      if (paste) this.queuedPaste += text.length;
      else this.queuedKeys += text.length;
      this.pending.push({ text, paste });
      return "queued";
    }
    return this.state === "ended" ? "ended" : "none";
  }
  private clearPending() {
    this.pending = [];
    this.queuedKeys = this.queuedPaste = 0;
  }

  /** Shows the terminal in `box` (first time: starts the shell, sized to it). */
  attach(box: HTMLElement) {
    if (this.host.parentElement !== box) box.appendChild(this.host);
    if (!this.opened) {
      this.opened = true;
      this.term.open(this.host);
    }
    this.fitNow();
    if (this.state === "idle") void this.start();
    if (takeFocusWhenShown(this.spec.sid)) this.term.focus();
  }

  detach() {
    this.host.remove();
  }

  fitNow() {
    if (!this.host.isConnected || !this.host.clientWidth || !this.host.clientHeight) return;
    try {
      this.fit.fit();
    } catch {
      /* not measurable yet */
    }
  }

  private async start() {
    const run = ++this.run;
    this.state = "starting";
    this.unacked = 0;
    this.clearPending();
    // the shell that starts now may be another kind (Settings › Terminal shell)
    this.quoting = null;
    // "don't ask again" was for the shell that ran before
    setPasteTrust(this.spec.sid, false);
    const ch = new Channel<Msg>();
    ch.onmessage = (m) => {
      if (run !== this.run) return;
      if (m instanceof ArrayBuffer || ArrayBuffer.isView(m)) {
        const bytes = m instanceof ArrayBuffer ? new Uint8Array(m) : new Uint8Array(m.buffer, m.byteOffset, m.byteLength);
        this.term.write(bytes, () => this.ack(bytes.byteLength));
      } else if (m && typeof m === "object" && "exit" in m) this.ended();
    };
    const { profileId, bucket, prefix } = this.spec;
    try {
      const { cols, rows } = this.term;
      const info = await invoke<Info>("terminal_open", { profileId, bucket, prefix, cols, rows, shell: terminalShell() || null, onOutput: ch });
      if (run !== this.run) {
        void invoke("terminal_close", { id: info.id }).catch(() => {});
        return;
      }
      this.id = info.id;
      this.remoteBase = info.remoteBase;
      this.quoting = info.quoting ?? null;
      this.state = "running";
      // a resize while the shell was starting (onResize skips it without an id) would leave the
      // PTY at the old size: send what the terminal is now if it moved meanwhile
      if (this.term.cols !== cols || this.term.rows !== rows)
        void invoke("terminal_resize", { id: info.id, cols: this.term.cols, rows: this.term.rows }).catch(() => {});
      for (const line of takeStartup(this.spec.sid)) this.send(`${line}\r`);
      const queued = this.pending;
      this.clearPending();
      for (const q of queued) this.deliver(q.text, q.paste);
    } catch (e) {
      if (run !== this.run) return;
      this.state = "ended";
      this.clearPending();
      const msg = typeof e === "string" ? e : String((e as Error)?.message ?? e);
      // the first paragraph says it; details (protocol text) stay out of the terminal
      this.term.write(`\r\n\x1b[31m${msg.split("\n\n")[0].replace(/\n/g, "\r\n")}\x1b[0m\r\n\x1b[2m[Press Enter to try again]\x1b[0m\r\n`);
    }
  }

  private ended() {
    this.state = "ended";
    this.id = null;
    this.term.write("\r\n\x1b[2m[Process exited — press Enter to restart]\x1b[0m\r\n");
  }

  private ack(n: number) {
    this.unacked += n;
    if (this.unacked >= ACK_STEP) return this.flushAck();
    if (!this.ackTimer) this.ackTimer = window.setTimeout(() => this.flushAck(), 50);
  }
  private flushAck() {
    window.clearTimeout(this.ackTimer);
    this.ackTimer = 0;
    const n = this.unacked;
    this.unacked = 0;
    if (n && this.id != null) void invoke("terminal_ack", { id: this.id, bytes: n }).catch(() => {});
  }

  private send(data: string, binary = false) {
    if (this.id != null) void invoke("terminal_write", { id: this.id, data, binary }).catch(() => {});
  }

  /** Sends `text` as typed keys (not a paste: a line ending in \r runs), the keyboard left alone. */
  type(text: string): boolean {
    if (this.state !== "running") return false;
    this.send(text);
    return true;
  }

  /** Whether a program runs in the foreground: asked of the terminal on This Mac; null over SSH. */
  async busy(): Promise<boolean | null> {
    if (this.state !== "running" || this.id == null) return false;
    return invoke<boolean | null>("terminal_busy", { id: this.id }).catch(() => null);
  }

  /**
   * Whether closing it would end a program: This Mac asks the terminal; a server (or WSL) can't say, so
   * a shell that isn't waiting at its prompt counts as busy (an `apt upgrade`, a `vim`).
   */
  async ending(): Promise<boolean | null> {
    // WSL's programs are Linux processes Windows can't see: judged by the prompt, like a server
    if (this.remoteBase == null && this.quoting !== "wsl") return this.busy();
    return this.state === "running" && !(await this.idle());
  }

  /**
   * Whether the shell waits at its prompt with nothing typed: the screen isn't a full-screen
   * program's, the line up to the cursor ends in a prompt ("$ ", "% ", "# ", and on This Mac,
   * where the terminal also says no program runs, "> " and "❯ "), nothing was typed a moment
   * ago, and on This Mac no program holds the terminal. Cheap and cautious: when in doubt, busy.
   */
  async idle(): Promise<boolean> {
    if (this.state !== "running") return false;
    // keys typed a moment ago may not be echoed yet: the line isn't known
    if (Date.now() - this.lastInput < TYPED_LATELY) return false;
    const b = this.term.buffer.active;
    if (b.type !== "normal") return false;
    const line = b.getLine(b.baseY + b.cursorY)?.translateToString(false, 0, b.cursorX) ?? "";
    const local = this.remoteBase == null;
    if (!(local ? PROMPT_LOCAL : PROMPT_REMOTE).test(line)) return false;
    if (local && (await this.busy()) === true) return false;
    return true;
  }

  private input(d: string, binary: boolean) {
    this.lastInput = Date.now();
    if (this.state === "running") return this.send(d, binary);
    if (this.state === "starting" && !binary) return void this.deliver(d, false);
    if (this.state === "ended" && d.includes("\r")) this.restart();
  }

  /** Types `text` as if pasted (bracketed paste when the shell asks for it); while the shell starts, once it runs. */
  write(text: string): TermWrite {
    const r = this.deliver(cleanPaste(text), true);
    if (r === "typed" || r === "queued") this.term.focus();
    return r;
  }

  restart() {
    this.closeBackend();
    this.term.write("\r\n");
    void this.start();
  }

  private closeBackend() {
    this.run++;
    window.clearTimeout(this.ackTimer);
    this.ackTimer = 0;
    if (this.id != null) void invoke("terminal_close", { id: this.id }).catch(() => {});
    this.id = null;
    this.state = "ended";
  }

  action(a: TermAction) {
    switch (a) {
      case "clear":
        this.term.clear();
        break;
      case "restart":
        this.restart();
        break;
      case "copy": {
        const s = this.term.getSelection();
        if (s) void navigator.clipboard?.writeText(s).catch(() => {});
        break;
      }
      case "paste":
        void navigator.clipboard
          ?.readText()
          .then((t) => this.pasteText(t))
          .catch(() => {});
        break;
      case "font+":
      case "font-":
      case "font0":
        setFont(a === "font0" ? FONT_DEFAULT : fontSize + (a === "font+" ? 1 : -1));
        return;
    }
    this.term.focus();
  }

  dispose() {
    this.closeBackend();
    setPasteTrust(this.spec.sid, false);
    this.term.dispose();
    this.host.remove();
  }
}

/** ⌃` or ⌘J: back and forth between a terminal and its file pane. */
export const isToggleKey = (e: KeyboardEvent) =>
  (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.code === "Backquote" || e.key === "`")) ||
  (cmdKey(e) && !e.altKey && !e.shiftKey && e.code === "KeyJ");

/** ⌘ on a Mac, Ctrl elsewhere (alone), where the app's shortcuts sit. */
const cmdKey = (e: KeyboardEvent) => (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

/** App shortcuts the shell never gets: ⌃Tab / ⌃⇧Tab (next / previous workspace). */
const passKey = (e: KeyboardEvent) => e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab";

/**
 * The pane's own key, normalized: Shift changes what - / 0 / = type ("_", ")", "+" on a US
 * layout), and Ctrl+Shift is the modifier off the Mac, so those three also match by position.
 */
export function ownKeyName(e: KeyboardEvent): string {
  const k = e.key.toLowerCase();
  if (k === "=" || k === "+" || k === "-" || k === "0") return k;
  if (e.code === "Minus") return "-";
  if (e.code === "Digit0") return "0";
  if (e.code === "Equal") return "=";
  return k;
}

/** Keys the pane handles itself, kept from xterm.js: ⌘K, ⌘C with a selection, ⌘+ / ⌘− / ⌘0, ⌃`. */
export function ownKey(e: KeyboardEvent): boolean {
  const mod = MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey;
  if (isToggleKey(e)) return true;
  if (!mod || e.altKey) return false;
  const k = ownKeyName(e);
  return k === "k" || k === "=" || k === "+" || k === "-" || k === "0" || (k === "c" && sessionsWithSelection());
}
const sessionsWithSelection = () => [...sessions.values()].some((s) => s.term.hasSelection());

const sessions = new Map<string, Session>();

export function sessionFor(spec: TermSpec): Session {
  let s = sessions.get(spec.sid);
  if (!s) {
    s = new Session(spec);
    sessions.set(spec.sid, s);
  }
  return s;
}

function setFont(n: number) {
  fontSize = clampFont(n);
  LS.set(FONT_KEY, String(fontSize));
  for (const s of sessions.values()) {
    s.term.options.fontSize = fontSize;
    s.fitNow();
  }
}

// the app's light / dark theme, accent and font follow into every terminal
new MutationObserver(() => {
  const t = theme();
  const f = monoFont();
  for (const s of sessions.values()) {
    s.term.options.theme = t;
    if (s.term.options.fontFamily !== f) s.term.options.fontFamily = f;
  }
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent", "data-font", "style"] });

setTermImpl({
  write: (sid, text) => sessions.get(sid)?.write(text),
  gc: (keep) => {
    for (const [sid, s] of sessions) {
      if (keep.has(sid)) continue;
      s.dispose();
      sessions.delete(sid);
    }
  },
  action: (sid, a) => sessions.get(sid)?.action(a),
  remoteBase: (sid) => sessions.get(sid)?.remoteBase,
  quoting: (sid) => sessions.get(sid)?.quoting,
  type: (sid, text) => sessions.get(sid)?.type(text) ?? false,
  idle: async (sid) => (await sessions.get(sid)?.idle()) ?? false,
  busy: async (sid) => (sessions.get(sid) ? sessions.get(sid)!.ending() : null),
});
