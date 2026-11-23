// Permissions sheet: octal text and the rwx grid kept in step. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { bitsFromText, digits, startBits } from "../../src/perms/permBits.ts";

test("one item: grid and digits", () => {
  const b = startBits([0o644]);
  assert.deepEqual(b, [true, true, false, true, false, false, true, false, false]);
  assert.equal(digits(b), "644");
  assert.equal(digits(startBits([0o755])), "755");
  assert.equal(digits(startBits([0o000])), "000");
});

test("mixed selection shows x, unknown mode is mixed", () => {
  assert.equal(digits(startBits([0o644, 0o664])), "6x4");
  assert.equal(digits(startBits([0o644, undefined])), "xxx");
});

test("typed digits set the grid; invalid text is ignored", () => {
  const init = startBits([0o644]);
  assert.deepEqual(bitsFromText("750", init), startBits([0o750]));
  assert.equal(bitsFromText("75", init), null);
  assert.equal(bitsFromText("789", init), null);
});

test("typing x back restores the selection's own bits, not the last typed ones", () => {
  const init = startBits([0o644, 0o664]);
  const after644 = bitsFromText("644", init)!;
  assert.equal(digits(after644), "644");
  const back = bitsFromText("6x4", init)!;
  assert.deepEqual(back, init);
  assert.equal(digits(back), "6x4");
});
