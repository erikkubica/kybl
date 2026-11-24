// Custom action templates (src/actions/templateCheck.ts, mirrors check_template in actions.rs:
// both run template-vectors.json). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { templateProblem } from "../../src/actions/templateCheck.ts";

const vectors = JSON.parse(readFileSync(new URL("./template-vectors.json", import.meta.url), "utf8")) as { bad: [string, string][]; ok: string[] };

test("placeholders where the quoting can't be proven are refused (shared vectors)", () => {
  for (const [bad, want] of vectors.bad) {
    const problem = templateProblem(bad);
    assert.ok(problem, JSON.stringify(bad));
    assert.ok(problem.includes(want), `${JSON.stringify(bad)}: ${problem}`);
  }
  assert.match(templateProblem(`x "{path}"`)!, /^\{path\} is inside quotes/);
});

test("placeholders outside quotes, and in $( … ), are fine (shared vectors)", () => {
  for (const ok of vectors.ok) assert.equal(templateProblem(ok), null, JSON.stringify(ok));
});
