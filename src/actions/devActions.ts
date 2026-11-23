/**
 * Browser dev mock of the custom actions backend (src-tauri/src/actions.rs): the same expansion
 * and quoting, and made-up output streamed as `custom-action-output` events. A command with
 * "sleep" streams for a while (to try Stop); "false" or "exit N" fails.
 */
import { emit } from "@tauri-apps/api/event";

type Item = { path: string; isDir: boolean };
const PER_ITEM = ["path", "name", "ext", "stem"];

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const arg = (s: string) => quote(s.startsWith("-") ? `./${s}` : s);
const nameOf = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
function splitExt(name: string, dir: boolean): [string, string] {
  const i = name.lastIndexOf(".");
  return !dir && i > 0 && i + 1 < name.length ? [name.slice(0, i), name.slice(i + 1)] : [name, ""];
}
const uses = (t: string, w: string) => new RegExp(`(^|[^$])\\{${w}\\}`).test(t);
const sub = (t: string, value: (w: string) => string | undefined) => t.replace(/(\$?)\{(\w+)\}/g, (m, dollar, w) => (dollar ? m : (value(w) ?? m)));

export function expand(template: string, items: Item[], dir: string): string[] {
  const paths = items.map((i) => arg(i.path)).join(" ");
  const common = (w: string) => (w === "paths" ? paths : w === "dir" ? arg(dir) : undefined);
  if (!PER_ITEM.some((w) => uses(template, w))) return [sub(template, common)];
  return items.map((it) => {
    const name = nameOf(it.path);
    const [stem, ext] = splitExt(name, it.isDir);
    return sub(template, (w) => ({ path: arg(it.path), name: arg(name), stem: arg(stem), ext: quote(ext) })[w] ?? common(w));
  });
}

const stopped = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (runId: string, stream: "out" | "err" | "note", text: string) => emit("custom-action-output", { runId, stream, text });

/** Some believable output for one command line. */
function fakeOutput(line: string, items: Item[]): { lines: [stream: "out" | "err", text: string][]; code: number } {
  const hex = (s: string) => [...Array(64)].map((_, i) => "0123456789abcdef"[(s.charCodeAt(i % s.length) * (i + 7)) % 16]).join("");
  const fail = /\bfalse\b/.test(line) ? 1 : Number(/\bexit (\d+)/.exec(line)?.[1] ?? 0);
  if (/shasum|sha256sum/.test(line)) return { lines: items.map((i) => ["out", `${hex(i.path)}  ${i.path}\n`]), code: fail };
  if (/\bdu\b/.test(line)) return { lines: items.map((i) => ["out", `${(Math.abs(i.path.length * 37) % 900) + 4}M\t${i.path}\n`]), code: fail };
  if (/\bsips\b/.test(line))
    return { lines: items.flatMap((i): [ "out", string][] => [["out", `${i.path}\n`], ["out", `  ${i.path.replace(/^.*\//, "")}: resized to 2048 px\n`]]), code: fail };
  if (/chmod/.test(line)) return { lines: fail ? [["err", "chmod: Operation not permitted\n"]] : [], code: fail };
  return { lines: [["out", `ran: ${line}\n`], ...(fail ? [["err", `command failed with exit code ${fail}\n`] as ["err", string]] : [])], code: fail };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleAction(cmd: string, a: any): Promise<unknown> {
  switch (cmd) {
    case "custom_action_preview":
      return expand(a.template, a.items, a.dir);
    case "custom_action_stop":
      stopped.add(a.runId);
      return null;
    case "cancel_transfer":
      stopped.add(a.id);
      return null;
    case "custom_action_run": {
      const { runId, template, onServer, items, dir } = a.spec as { runId: string; template: string; onServer: boolean; items: Item[]; dir: string };
      // server keys become paths under the mock server's folder
      const abs = (k: string) => (onServer ? `/var/www/${k}`.replace(/\/+$/, "") : k);
      const its = items.map((i) => ({ path: abs(i.path), isDir: i.isDir }));
      const lines = expand(template, its, abs(dir));
      await sleep(onServer ? 500 : 150);
      let code = 0;
      let commands = 0;
      for (const [n, line] of lines.entries()) {
        if (stopped.has(runId)) break;
        if (lines.length > 1) await out(runId, "note", `[${n + 1} of ${lines.length}]\n`);
        commands++;
        const slow = /\bsleep\b/.test(line);
        const f = fakeOutput(line, lines.length > 1 ? [its[n]] : its);
        const rows = slow ? Array.from({ length: 80 }, (_, i): ["out" | "err", string] => [i % 9 === 8 ? "err" : "out", `${i % 9 === 8 ? "warning" : "line"} ${i + 1}: working on it…\n`]) : f.lines;
        for (const [s, t] of rows) {
          if (stopped.has(runId)) break;
          await out(runId, s, t);
          await sleep(slow ? 120 : 40);
        }
        if (f.code) code = f.code;
      }
      if (stopped.has(runId)) {
        stopped.delete(runId);
        return { code: null, stopped: true, truncated: false, commands };
      }
      return { code, stopped: false, truncated: false, commands };
    }
  }
  return undefined;
}
