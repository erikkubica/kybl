// Where invalid JSON goes wrong (src/viewers/jsonCheck.ts). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeJsonError, jsonErrorOffset } from "../../src/viewers/jsonCheck.ts";

test("valid JSON has no error", () => {
  for (const s of ['{"a":[1,2,{"b":null}],"c":"x\\u00e9\\n"}', "  [ ]  ", "{}", "-0.5e+10", '"\\""', "true", "[[[[[]]]]]", '{"a":{"b":{}}}']) {
    assert.equal(jsonErrorOffset(s), -1, s);
  }
});

test("finds the bad character", () => {
  assert.equal(jsonErrorOffset('{"a":1,}'), 7);
  assert.equal(jsonErrorOffset("[1,]"), 3);
  assert.equal(jsonErrorOffset('{"a" 1}'), 5);
  assert.equal(jsonErrorOffset("[1 2]"), 3);
  assert.equal(jsonErrorOffset('{"a":01}'), 6);
  assert.equal(jsonErrorOffset("[1,2"), 4);
  assert.equal(jsonErrorOffset("{} x"), 3);
  assert.equal(jsonErrorOffset('["a\tb"]'), 3);
  assert.equal(jsonErrorOffset("[tru]"), 4);
  assert.equal(jsonErrorOffset(""), 0);
});

test("agrees with JSON.parse on mutated documents", () => {
  const base = '{"name":"Kybl","list":[1,-2.5,3e2,true,false,null,{"x":"\\u0041\\\\"}],"empty":{},"arr":[]}';
  const junk = ['"', ",", "}", "]", "{", "[", ":", "x", " ", "0", "-", ".", "\\"];
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let k = 0; k < 3000; k++) {
    const at = rnd(base.length);
    const s = rnd(2) ? base.slice(0, at) + junk[rnd(junk.length)] + base.slice(at) : base.slice(0, at) + base.slice(at + 1);
    let valid = true;
    try {
      JSON.parse(s);
    } catch {
      valid = false;
    }
    assert.equal(jsonErrorOffset(s) === -1, valid, s);
  }
});

test("message with line and column, whatever the engine said", () => {
  const text = '{\n  "a": 1,\n  "b": }\n';
  assert.equal(describeJsonError(text, "JSON Parse error: Unexpected token '}'"), "Line 3, column 8: Unexpected token '}'");
  assert.equal(describeJsonError(text, "Unexpected token } in JSON at position 19"), "Line 3, column 8: Unexpected token }");
  assert.equal(describeJsonError('[1,]', "Unexpected token ']', \"[1,]\" is not valid JSON", 4), "Line 4, column 4: Unexpected token ']'");
});
