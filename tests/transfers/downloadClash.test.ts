// Name clashes of downloads (src/desktop/lib/downloadClash.ts): asked once per batch, "all" holds for
// files found later, and a remembered answer is used without asking. Run: pnpm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { downloadClashGate, resolveDownloadClashes as resolve } from "../../src/desktop/lib/downloadClash.ts";

// the disk check: these paths "exist"
const onDisk = new Set<string>();
const exists = async (paths: string[]) => new Set(paths.filter((p) => onDisk.has(p)));
const resolveDownloadClashes = (items: { name: string; local: string }[], ask: never, where: string) => resolve(items, ask, exists, where);

type Choice = "replace" | "skip" | "keep";
const item = (name: string) => ({ name, local: `/d/${name}` });

/** A stand-in for the dialog: answers each question from `answers`, and sets `sticky` like the real one. */
function asker(answers: { choice: Choice; all?: boolean }[]) {
  const asked: string[][] = [];
  const ask = async (clashes: { key: string; name: string }[], _verb: string, _where: string, opts: { sticky?: { file?: Choice } } = {}) => {
    const out = new Map<string, Choice>();
    for (const c of clashes) {
      if (opts.sticky?.file) {
        out.set(c.key, opts.sticky.file);
        continue;
      }
      const a = answers.shift();
      if (!a) return null;
      asked.push([c.name]);
      out.set(c.key, a.choice);
      if (a.all && opts.sticky) opts.sticky.file = a.choice;
    }
    return out;
  };
  return { ask, asked };
}

beforeEach(() => {
  onDisk.clear();
});

test("files that are not there start without asking", async () => {
  const { ask, asked } = asker([]);
  const r = await resolveDownloadClashes([item("a.txt"), item("b.txt")], ask as never, "Downloads");
  assert.equal(r?.items.length, 2);
  assert.equal(asked.length, 0);
});

test("Replace marks the download to overwrite, Skip leaves it out, Keep both leaves it as it is", async () => {
  for (const n of ["a.txt", "b.txt", "c.txt"]) onDisk.add(`/d/${n}`);
  const { ask } = asker([{ choice: "replace" }, { choice: "skip" }, { choice: "keep" }]);
  const r = await resolveDownloadClashes([item("a.txt"), item("b.txt"), item("c.txt")], ask as never, "Downloads");
  assert.deepEqual(
    r?.items.map((i) => [i.name, (i as { overwrite?: boolean }).overwrite ?? false]),
    [
      ["a.txt", true],
      ["c.txt", false],
    ],
  );
  assert.equal(r?.skipped, 1);
});

test("closing the question calls the whole download off", async () => {
  onDisk.add("/d/a.txt");
  const { ask } = asker([]);
  assert.equal(await resolveDownloadClashes([item("a.txt")], ask as never, "Downloads"), null);
});

test("Do this for all covers the files found later, and a streaming batch is asked once", async () => {
  for (let i = 0; i < 6; i++) onDisk.add(`/d/f${i}`);
  const { ask, asked } = asker([{ choice: "skip", all: true }]);
  const started: string[] = [];
  const gate = downloadClashGate({ ask: ask as never, exists, where: "Downloads", start: (b) => started.push(...b.map((i) => i.name)) });
  gate.add([item("f0"), item("f1")]);
  // arrive while the first question is open: they wait and are decided together afterwards
  gate.add([item("f2"), item("new1")]);
  gate.add([item("f3"), item("f4")]);
  gate.end();
  await gate.settled();
  gate.add([item("f5")]);
  await gate.settled();
  assert.equal(asked.length, 1, "one question for the whole download");
  assert.deepEqual(started, ["new1"]);
  assert.equal(gate.skipped, 6);
});

test("the dialog is told this is a download, so it can remember the answer", async () => {
  onDisk.add("/d/a.txt");
  let offered: unknown;
  const ask = async (clashes: { key: string }[], _v: string, _w: string, opts?: { remember?: string }) => {
    offered = opts?.remember;
    return new Map(clashes.map((c) => [c.key, "replace" as Choice]));
  };
  const r = await resolveDownloadClashes([item("a.txt")], ask as never, "Downloads");
  assert.equal(offered, "download");
  assert.equal((r?.items[0] as { overwrite?: boolean }).overwrite, true);
});
