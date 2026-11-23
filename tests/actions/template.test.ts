// Custom action templates (src/actions/templateCheck.ts, mirrors check_template in actions.rs). Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { templateProblem } from "../../src/actions/templateCheck.ts";

test("a placeholder inside the template's own quotes or backticks is refused", () => {
  for (const bad of [`convert "{path}" out.png`, `echo '{name}'`, `echo "a {paths} b"`, "echo `basename {path}`", 'x "$(echo `y {dir}`)"', `echo "it's {stem}"`]) {
    assert.ok(templateProblem(bad), bad);
  }
  assert.match(templateProblem(`x "{path}"`)!, /^\{path\} is inside quotes/);
});

test("placeholders outside quotes, and $( … ), are fine", () => {
  for (const ok of [
    "convert {path} out.png",
    `echo "$(basename {path})"`,
    "awk '{print $1}' {path}",
    'echo "${path}" {name}',
    `echo "a" {path} 'b'`,
    'echo \\"{path}\\"',
    "echo $( (cd {dir}) ) {path}",
    'echo "{unknown}" {ext}',
  ]) {
    assert.equal(templateProblem(ok), null, ok);
  }
});

test("a placeholder in a here-document, or right after a backslash, is refused", () => {
  for (const bad of ["cat <<EOF\n{name}\nEOF", "cat <<-'X'\n{path}\nX", "echo \\{path}", "x $(cat <<E\n{dir}\nE\n)"]) {
    assert.ok(templateProblem(bad), JSON.stringify(bad));
  }
  assert.match(templateProblem("echo \\{path}")!, /backslash/);
  assert.match(templateProblem("cat <<EOF\n{name}\nEOF")!, /here-document/);
  // bash's here-string, a quoted "<<" and an escaped backslash are fine
  for (const ok of ["cat <<< {path}", "echo '<<' {path}", "echo \\\\ {path}"]) {
    assert.equal(templateProblem(ok), null, ok);
  }
});
