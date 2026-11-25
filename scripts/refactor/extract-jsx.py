#!/usr/bin/env python3
# Moves a run of JSX out of AppShell's return into a component of its own (src/shell/components),
# its props typed by the checker: the JSX becomes a statement, extract-hook moves that, and the
# hook it makes is turned into the component.
#   python3 scripts/refactor/extract-jsx.py <fromLine> <toLine> <Component> [hintFile]
import json, re, subprocess, sys
a, b, name = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
hint = sys.argv[4] if len(sys.argv) > 4 else None
F = "src/shell/AppShell.tsx"
lines = open(F).read().split("\n")
jsx = lines[a - 1:b]
lines[a - 1:b] = ["      {__el}"]
at = next(i for i, l in enumerate(lines) if l.strip().startswith("// what the parts above call through `late`"))
block = ["  const __el = (", "    <>"] + jsx + ["    </>", "  );"]
lines[at:at] = block
open(F, "w").write("\n".join(lines))
s0, s1 = at + 1, at + len(block)
hook = "use" + name
out = json.loads(subprocess.run(["node", "scripts/refactor/extract-hook.mjs", F, "AppShell", str(s0), str(s1), hook, f"src/shell/components/{name}.tsx"], check=True, capture_output=True, text=True).stdout)
if out["late"]:
    sys.exit("late names in JSX: " + " ".join(out["late"]))
path = out["out"]
src = open(path).read()
src = src.replace(f"Use{name}Deps", f"{name}Props")
src = re.sub(rf"export function {hook}\((\w+): {name}Props\) \{{\n  const __el = \(", rf"export function {name}(\1: {name}Props) {{\n  return (", src)
src = src.replace(f"export function {hook}() {{\n  const __el = (", f"export function {name}() {{\n  return (")
src = re.sub(r"\n  return \{ __el \};\n\}", "\n}", src)
open(path, "w").write(src)
s = open(F).read()
m = re.search(rf"\n  const \{{ __el \}} = {hook}\((?:\{{ ([^}}]*) \}})?\);", s)
props = [p.strip() for p in (m.group(1) or "").split(",") if p.strip()]
s = s[:m.start()] + s[m.end():]
s = s.replace("{__el}", f"<{name} " + " ".join(f"{p}={{{p}}}" for p in props) + " />")
s = s.replace(f'import {{ {hook} }} from "./components/{name}";', f'import {{ {name} }} from "./components/{name}";')
open(F, "w").write(s)
subprocess.run(["python3", "scripts/refactor/destructure-props.py", path, name], check=True)
args = ["node", "scripts/refactor/fix-imports.mjs"] + (["--from", hint, "--at", "src/shell"] if hint else []) + [F, path]
subprocess.run(args, check=True)
print(name, "props:", ", ".join(props))
