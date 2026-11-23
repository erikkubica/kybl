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
import { LS } from "../browser/types";
import { setTermImpl, takeStartup, type TermAction, type TermSpec } from "./api";

const SCROLLBACK = 5000;
const FONT_KEY = "s3b.term.font";
const FONT_DEFAULT = 12;
const FONT_MIN = 9;
const FONT_MAX = 24;
/** acknowledged in steps this big (or after a short pause), not per batch */
const ACK_STEP = 64 * 1024;

type Info = { id: number; remoteBase: string | null };
type Msg = ArrayBuffer | { exit: number | null };

const MAC = /Mac/i.test(navigator.platform || navigator.userAgent);

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
  private opened = false;

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
    });
    this.term.loadAddon(this.fit);
    this.term.onData((d) => this.input(d, false));
    this.term.onBinary((d) => this.input(d, true));
    this.term.onResize(({ cols, rows }) => {
      if (this.id != null) void invoke("terminal_resize", { id: this.id, cols, rows }).catch(() => {});
    });
    // the app's own keys: xterm.js leaves them alone (handled on the pane, see TermView)
    this.term.attachCustomKeyEventHandler((e) => !ownKey(e));
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
      const info = await invoke<Info>("terminal_open", { profileId, bucket, prefix, cols: this.term.cols, rows: this.term.rows, onOutput: ch });
      if (run !== this.run) {
        void invoke("terminal_close", { id: info.id }).catch(() => {});
        return;
      }
      this.id = info.id;
      this.remoteBase = info.remoteBase;
      this.state = "running";
      for (const line of takeStartup(this.spec.sid)) this.send(`${line}\r`);
    } catch (e) {
      if (run !== this.run) return;
      this.state = "ended";
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

  private input(d: string, binary: boolean) {
    if (this.state === "running") return this.send(d, binary);
    if (this.state === "ended" && d.includes("\r")) this.restart();
  }

  /** Types `text` as if pasted (bracketed paste when the shell asks for it). */
  write(text: string): boolean {
    if (this.state !== "running") return false;
    this.term.paste(text);
    this.term.focus();
    return true;
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
          .then((t) => t && this.state === "running" && this.term.paste(t))
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
    this.term.dispose();
    this.host.remove();
  }
}

/** ⌃`: back and forth between a terminal and its file pane. */
export const isToggleKey = (e: KeyboardEvent) => e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.code === "Backquote" || e.key === "`");

/** Keys the pane handles itself, kept from xterm.js: ⌘K, ⌘C with a selection, ⌘+ / ⌘− / ⌘0, ⌃`. */
export function ownKey(e: KeyboardEvent): boolean {
  const mod = MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey;
  if (isToggleKey(e)) return true;
  if (!mod || e.altKey) return false;
  const k = e.key.toLowerCase();
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
  write: (sid, text) => sessions.get(sid)?.write(text) ?? false,
  gc: (keep) => {
    for (const [sid, s] of sessions) {
      if (keep.has(sid)) continue;
      s.dispose();
      sessions.delete(sid);
    }
  },
  action: (sid, a) => sessions.get(sid)?.action(a),
  remoteBase: (sid) => sessions.get(sid)?.remoteBase,
});
