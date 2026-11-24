/**
 * The browser mock's terminal backend (dev only, see devMock.ts): a fake shell that echoes what
 * is typed, runs a few commands (pwd, cd, ls, size, echo, clear, sleep, exit, yes) and prints a prompt, so
 * terminal panes can be tried without Tauri. `window.__kyblTerms` lists the live fake sessions.
 */
import type { Channel } from "@tauri-apps/api/core";
import type { Profile } from "../types";
import { ON_OS } from "../osNames";

type Fake = { out: Channel<unknown>; cwd: string; cols: number; rows: number; line: string; acked: number; sent: number; busy?: boolean };
const live = new Map<number, Fake>();
let next = 1;
(window as unknown as { __kyblTerms: typeof live }).__kyblTerms = live;

const enc = new TextEncoder();
const send = (f: Fake, s: string) => {
  const b = enc.encode(s);
  f.sent += b.byteLength;
  // the real channel hands raw bytes over as an ArrayBuffer
  (f.out.onmessage as (m: unknown) => void)(b.buffer);
};
const prompt = (f: Fake) => send(f, `\x1b[32mmock\x1b[0m:\x1b[34m${f.cwd}\x1b[0m$ `);

function run(id: number, f: Fake, cmd: string) {
  const [name, ...args] = cmd.trim().split(/\s+/);
  switch (name) {
    case "":
      break;
    case "pwd":
      send(f, `${f.cwd}\r\n`);
      break;
    case "cd": {
      // one word, maybe in single quotes (as Kybl types it)
      const rest = cmd.trim().slice(2).trim();
      const m = /^'((?:[^']|'\\'')*)'$/.exec(rest);
      f.cwd = m ? m[1].replace(/'\\''/g, "'") : rest || "~";
      break;
    }
    case "sleep": {
      // a program holding the terminal: no prompt until it ends (terminal_busy says so meanwhile)
      f.busy = true;
      setTimeout(() => {
        f.busy = false;
        if (live.get(id) === f) prompt(f);
      }, Math.min(60, Number(args[0]) || 1) * 1000);
      return;
    }
    case "ls":
      send(f, "README.md  index.html  package.json  \x1b[34msrc\x1b[0m\r\n");
      break;
    case "size":
      send(f, `${f.cols}x${f.rows}\r\n`);
      break;
    case "echo":
      send(f, `${args.join(" ")}\r\n`);
      break;
    case "clear":
      send(f, "\x1b[2J\x1b[H");
      break;
    case "yes":
      // a burst, to see batching and flow control at work
      send(f, "y\r\n".repeat(2000));
      break;
    case "exit":
      live.delete(id);
      (f.out.onmessage as (m: unknown) => void)({ exit: Number(args[0] ?? 0) });
      return;
    default:
      send(f, `mock: ${name}: this is the browser mock's fake shell (try pwd, ls, size, echo, yes, exit)\r\n`);
  }
  prompt(f);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleTerminal(cmd: string, a: any, profiles: Profile[]): Promise<unknown> {
  switch (cmd) {
    case "terminal_open": {
      await new Promise((r) => setTimeout(r, 80));
      const p = profiles.find((x) => x.id === a.profileId);
      if (a.profileId !== "local" && p?.kind !== "sftp") throw `Terminals open on ${ON_OS.device} and on SFTP connections.`;
      if (p?.net?.host.startsWith("bad")) throw `Couldn't find ${p.net.host}. Check the address.\n\ndns error`;
      const base = a.profileId === "local" ? null : p?.net?.basePath || "~";
      const cwd = a.profileId === "local" ? [String(a.bucket).replace(/\/$/, ""), a.prefix.replace(/\/$/, "")].filter(Boolean).join("/") : [base, a.prefix.replace(/\/$/, "")].filter(Boolean).join("/");
      const id = next++;
      const f: Fake = { out: a.onOutput, cwd, cols: a.cols, rows: a.rows, line: "", acked: 0, sent: 0 };
      live.set(id, f);
      setTimeout(() => {
        send(f, `Kybl mock shell on ${p?.name ?? ON_OS.device} (${a.cols}x${a.rows})\r\n`);
        prompt(f);
      }, 10);
      return { id, remoteBase: base };
    }
    case "terminal_write": {
      const f = live.get(a.id);
      if (!f) return null;
      for (const ch of a.data as string) {
        // a running program (sleep): what is typed goes nowhere
        if (f.busy) continue;
        if (ch === "\r") {
          send(f, "\r\n");
          const line = f.line;
          f.line = "";
          run(a.id, f, line);
        } else if (ch === "\x7f") {
          if (f.line) {
            f.line = f.line.slice(0, -1);
            send(f, "\b \b");
          }
        } else if (ch === "\x1b" || ch < " ") {
          // control keys: nothing in the fake
        } else {
          f.line += ch;
          send(f, ch);
        }
      }
      return null;
    }
    case "terminal_resize": {
      const f = live.get(a.id);
      if (f) Object.assign(f, { cols: a.cols, rows: a.rows });
      return null;
    }
    case "terminal_ack": {
      const f = live.get(a.id);
      if (f) f.acked += a.bytes;
      return null;
    }
    case "terminal_busy": {
      const f = live.get(a.id);
      return f ? !!f.busy : null;
    }
    case "terminal_close":
      live.delete(a.id);
      return null;
  }
  return null;
}
