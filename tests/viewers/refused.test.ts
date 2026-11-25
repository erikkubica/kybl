import assert from "node:assert/strict";
import { test } from "node:test";
import { DAMAGED, REFUSED, refusalKind } from "../../src/viewers/lib/refused.ts";

test("a broken zip is called damaged, a big or odd one refused", () => {
  const zip = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4]);
  // a download cut short: starts like a zip, no end record anywhere
  assert.equal(refusalKind("unusual zip layout", zip), DAMAGED);
  assert.equal(refusalKind("part runs past the end", zip), DAMAGED);
  assert.equal(refusalKind("unreadable zip", zip), DAMAGED);
  assert.equal(refusalKind("bad local header", zip), DAMAGED);
  // an end record exists: the layout is what is unusual
  const whole = new Uint8Array([0x50, 0x4b, 3, 4, 0x50, 0x4b, 5, 6, 0, 0, 0, 0]);
  assert.equal(refusalKind("unusual zip layout", whole), REFUSED);
  assert.equal(refusalKind("inflates too far", zip), REFUSED);
  assert.equal(refusalKind("part too big: a.xml", zip), REFUSED);
});
