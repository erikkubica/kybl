// Adds late-bound names to src/shell/lib/late.ts and AppShell's Object.assign(late, {…}).
//   node scripts/refactor/add-late.mjs "name: type;" …
import { readFileSync, writeFileSync } from "node:fs";
const LATE = "src/shell/lib/late.ts", SHELL = "src/shell/AppShell.tsx";
let late = readFileSync(LATE, "utf8"), shell = readFileSync(SHELL, "utf8");
for (const line of process.argv.slice(2)) {
  const name = line.split(":")[0].trim();
  if (new RegExp(`^  ${name}:`, "m").test(late)) continue;
  late = late.replace(/\n}\s*$/, `\n  ${line}\n}\n`);
  shell = shell.replace(/Object\.assign\(late, \{([^}]*)\}\);/, (_, l) => {
    const names = l.split(",").map((x) => x.trim()).filter(Boolean);
    names.push(name);
    return `Object.assign(late, { ${names.sort().join(", ")} });`;
  });
}
writeFileSync(LATE, late);
writeFileSync(SHELL, shell);
