// JSON Format without changing data (src/viewers/jsonFormat.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactJson, formatJson } from "../../src/viewers/jsonFormat.ts";

test("keeps number literals, key order and duplicate keys", () => {
  const src = `{"id": 12345678901234567890, "price": 1.50, "e": 1e5, "z": 1, "10": "a", "2": "b", "z": 2}`;
  assert.equal(
    formatJson(src, 2),
    `{\n  "id": 12345678901234567890,\n  "price": 1.50,\n  "e": 1e5,\n  "z": 1,\n  "10": "a",\n  "2": "b",\n  "z": 2\n}`,
  );
});

test("nested, empty containers, tabs", () => {
  const src = `{"a":[1,{"b":null},[],{ }],"c":{"d":true}}`;
  assert.equal(
    formatJson(src, "\t"),
    `{\n\t"a": [\n\t\t1,\n\t\t{\n\t\t\t"b": null\n\t\t},\n\t\t[],\n\t\t{}\n\t],\n\t"c": {\n\t\t"d": true\n\t}\n}`,
  );
});

test("strings are copied verbatim, including escapes and structural characters", () => {
  const src = `{ "k\\"ey" : "a, b: {c} [d] \\\\", "u": "\\u00e9  x" }`;
  const out = formatJson(src, 2);
  assert.equal(out, `{\n  "k\\"ey": "a, b: {c} [d] \\\\",\n  "u": "\\u00e9  x"\n}`);
  assert.deepEqual(JSON.parse(out), JSON.parse(src));
});

test("idempotent and value-preserving", () => {
  const src = `[ -0.0 , 1E-7, "x", false ]`;
  const once = formatJson(src, 4);
  assert.equal(formatJson(once, 4), once);
  assert.equal(once, `[\n    -0.0,\n    1E-7,\n    "x",\n    false\n]`);
});

test("scalars and compact form", () => {
  assert.equal(formatJson(" 42 "), "42");
  assert.equal(compactJson(`{ "a" : [ 1 , 2.0 ] , "b" : { } }`), `{"a":[1,2.0],"b":{}}`);
});
