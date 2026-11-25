// Moves a run of statements out of a component into a hook of their own, by the type checker:
// names the run uses from the component come in as typed deps (those declared further down
// through `late`, a late-bound object the component fills as it goes), imports are copied, and
// what the run declares and the component still uses is returned.
//
//   node scripts/refactor/extract-hook.mjs <file> <component> <fromLine> <toLine> <hookName> <outFile>
//
// It reports anything it can't do safely (a late name read while rendering) instead of guessing.
import ts from "typescript";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const [file, component, fromLine, toLine, hookName, outArg] = process.argv.slice(2);
const from = Number(fromLine), to = Number(toLine);
const cfgPath = ts.findConfigFile(".", ts.sys.fileExists, "tsconfig.json");
const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(cfgPath, ts.sys.readFile).config, ts.sys, path.dirname(cfgPath));
const program = ts.createProgram(cfg.fileNames.map((f) => path.resolve(f)), cfg.options);
const checker = program.getTypeChecker();
const sf = program.getSourceFile(path.resolve(file));
const text = sf.getFullText();
const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

// the component's body
let comp;
ts.forEachChild(sf, (n) => {
  if (ts.isFunctionDeclaration(n) && n.name?.text === component) comp = n;
});
if (!comp) throw new Error(`no function ${component}`);
const stmts = comp.body.statements;
const sel = stmts.filter((s) => lineOf(s.getStart(sf)) >= from && lineOf(s.getStart(sf)) <= to);
if (!sel.length) throw new Error("no statements in range");
const last = sel[sel.length - 1];
if (lineOf(last.getEnd()) > to) throw new Error(`statement at ${lineOf(last.getStart(sf))} runs past ${to} (to ${lineOf(last.getEnd())})`);
const rStart = sel[0].getFullStart(), rEnd = last.getEnd();
const inRange = (pos) => pos >= rStart && pos < rEnd;
// .tsx only when the moved code has JSX in it
let hasJsx = false;
const jsx = (n) => {
  if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) hasJsx = true;
  else ts.forEachChild(n, jsx);
};
sel.forEach(jsx);
const outFile = outArg.replace(/\.tsx?$/, "") + (hasJsx ? ".tsx" : ".ts");
const inComp = (d) => d.getSourceFile() === sf && d.pos >= comp.body.pos && d.end <= comp.body.end;

// what the range declares at its top level
const declared = new Map(); // name -> symbol
const declNames = (b) => {
  if (ts.isIdentifier(b)) declared.set(b.text, checker.getSymbolAtLocation(b));
  else for (const e of b.elements) if (!ts.isOmittedExpression(e)) declNames(e.name);
};
for (const s of sel) {
  if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) declNames(d.name);
  else if (ts.isFunctionDeclaration(s) && s.name) declared.set(s.name.text, checker.getSymbolAtLocation(s.name));
}

const declaredSyms = new Set(declared.values());
const symOf = (id) => {
  const p = id.parent;
  if (ts.isShorthandPropertyAssignment(p) && p.name === id) return checker.getShorthandAssignmentValueSymbol(p);
  return checker.getSymbolAtLocation(id);
};
const isRefPosition = (id) => {
  const p = id.parent;
  if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && p.name === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p)) && p.name === id) return false;
  if (ts.isJsxAttribute(p) && p.name === id) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return true;
};

// the deps parameter's name: one nothing in the range already uses (a callback's own `s`)
const used = new Set();
(function names(n) {
  if (ts.isIdentifier(n) && inRange(n.pos)) used.add(n.text);
  ts.forEachChild(n, names);
})(sf);
const P = ["s", "h", "deps", "shell"].find((x) => !used.has(x));
const deps = new Map(); // name -> {late, decl}
const imports = new Map(); // local name -> import declaration text pieces
const fileLocals = new Set();
const edits = []; // {pos, end, text}
const usedOutside = new Set();
const renderLate = [];
const insideFn = (n) => {
  for (let x = n.parent; x && inRange(x.pos); x = x.parent) if (ts.isFunctionLike(x)) return true;
  return false;
};

function visit(n) {
  if (ts.isIdentifier(n) && isRefPosition(n)) {
    const sym = symOf(n);
    const d = sym?.declarations?.[0];
    if (d) {
      const name = n.text;
      if (inRange(n.pos)) {
        if (inComp(d) && !inRange(d.pos)) {
          // a declaration of the component, outside the range
          const late = d.pos >= rEnd;
          if (!deps.has(name)) deps.set(name, { late, decl: d, sym });
          if (late && !insideFn(n)) renderLate.push(`${name} (line ${lineOf(n.getStart(sf))})`);
          const ref = late ? `${P}.late.${name}` : `${P}.${name}`;
          if (ts.isShorthandPropertyAssignment(n.parent)) edits.push({ pos: n.getStart(sf), end: n.getEnd(), text: `${name}: ${ref}` });
          else edits.push({ pos: n.getStart(sf), end: n.getEnd(), text: ref });
        } else if (d.getSourceFile() === sf && !inComp(d)) {
          if (ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d)) imports.set(name, d);
          else fileLocals.add(name);
        }
      } else if (sym && declaredSyms.has(sym)) usedOutside.add(name);
    }
  }
  ts.forEachChild(n, visit);
}
visit(sf);
if (renderLate.length) {
  console.error("Late names read while rendering (move the range later or pass them differently):\n  " + renderLate.join("\n  "));
  process.exit(2);
}

// the moved code, with its outside names rewritten
let body = text.slice(rStart, rEnd);
for (const e of edits.sort((a, b) => b.pos - a.pos)) body = body.slice(0, e.pos - rStart) + e.text + body.slice(e.end - rStart);

// a type for each dep
const FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
const aliases = [];
for (const f of program.getSourceFiles()) {
  if (f.isDeclarationFile || !path.resolve(f.fileName).includes("/src/")) continue;
  ts.forEachChild(f, (n) => {
    if ((ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && !n.typeParameters)
      aliases.push({ name: n.name.text, type: checker.getTypeAtLocation(n.name) });
  });
}
aliases.sort((a, b) => checker.typeToString(b.type, undefined, FLAGS).length - checker.typeToString(a.type, undefined, FLAGS).length);
const typeText = (name, info) => {
  const d = info.decl;
  if (ts.isVariableDeclaration(d) && d.type) return d.type.getText(sf);
  if (ts.isVariableDeclaration(d) && d.initializer && ts.isCallExpression(d.initializer) && ts.isIdentifier(d.initializer.expression)) {
    const callee = d.initializer.expression.text;
    if (/^use[A-Z]/.test(callee) && !["useState", "useRef", "useMemo", "useCallback", "useSyncExternalStore", "useContext", "useReducer"].includes(callee) && ts.isIdentifier(d.name)) {
      const cs = checker.getSymbolAtLocation(d.initializer.expression);
      const cd = cs?.declarations?.[0];
      if (cd && (ts.isImportSpecifier(cd) || ts.isImportClause(cd))) imports.set(callee, cd);
      else if (cd && cd.getSourceFile() === sf && !inComp(cd)) fileLocals.add(callee);
      return `ReturnType<typeof ${callee}>`;
    }
  }
  // one name out of a hook's result: const { term } = useShellLayout()
  if (ts.isBindingElement(d) && ts.isObjectBindingPattern(d.parent) && ts.isVariableDeclaration(d.parent.parent)) {
    const init = d.parent.parent.initializer;
    if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && /^use[A-Z]/.test(init.expression.text) && !["useState", "useRef", "useMemo", "useCallback", "useContext", "useReducer"].includes(init.expression.text)) {
      const callee = init.expression.text;
      const cs = checker.getSymbolAtLocation(init.expression);
      const cd = cs?.declarations?.[0];
      if (cd && (ts.isImportSpecifier(cd) || ts.isImportClause(cd))) imports.set(callee, cd);
      else if (cd && cd.getSourceFile() === sf && !inComp(cd)) fileLocals.add(callee);
      const key = (d.propertyName ?? d.name).getText(sf);
      return `ReturnType<typeof ${callee}>["${key}"]`;
    }
  }
  const t = checker.getTypeOfSymbolAtLocation(info.sym, d);
  let str = checker.typeToString(t, d, FLAGS);
  // named types the checker spells out in full (Pane = ReturnType<typeof usePane>) fold back to their names
  for (const a of aliases) {
    const full = checker.typeToString(a.type, d, FLAGS);
    if (full.length > 30 && str.includes(full)) str = str.split(full).join(a.name);
  }
  return str;
};
const depLines = [], lateLines = [];
for (const [name, info] of [...deps].sort()) (info.late ? lateLines : depLines).push(`  ${name}: ${typeText(name, info)};`);

// imports the moved code needs, re-pointed from the new file's folder
const outDir = path.dirname(path.resolve(outFile));
const relSpec = (spec) => {
  if (!spec.startsWith(".")) return spec;
  let r = path.relative(outDir, path.resolve(path.dirname(path.resolve(file)), spec)).split(path.sep).join("/");
  return r.startsWith(".") ? r : "./" + r;
};
const byModule = new Map();
for (const [name, d] of imports) {
  const decl = d.parent.parent.parent && ts.isImportDeclaration(d.parent.parent.parent) ? d.parent.parent.parent : ts.isImportDeclaration(d.parent.parent) ? d.parent.parent : d.parent;
  const mod = decl.moduleSpecifier.text;
  const isType = decl.importClause?.isTypeOnly || (ts.isImportSpecifier(d) && d.isTypeOnly);
  const entry = byModule.get(mod) ?? { names: [], def: null };
  if (ts.isImportClause(d)) entry.def = name;
  else if (ts.isNamespaceImport(d)) entry.ns = name;
  else entry.names.push((isType ? "type " : "") + (d.propertyName ? `${d.propertyName.text} as ${name}` : name));
  byModule.set(mod, entry);
}
const selfSpec = relSpec("./" + path.basename(file).replace(/\.tsx?$/, ""));
const importLines = [...byModule].map(([mod, e]) => {
  const parts = [];
  if (e.def) parts.push(e.def);
  if (e.ns) parts.push(`* as ${e.ns}`);
  if (e.names.length) parts.push(`{ ${e.names.join(", ")} }`);
  return `import ${parts.join(", ")} from "${relSpec(mod)}";`;
});
if (fileLocals.size) importLines.push(`import { ${[...fileLocals].join(", ")} } from "${selfSpec}";`);
const lateSpec = relSpec("./lib/late");

const returned = [...declared.keys()].filter((n) => usedOutside.has(n));
const depsName = hookName[0].toUpperCase() + hookName.slice(1) + "Deps";
const out = `${importLines.join("\n")}
${lateLines.length ? `import type { Late } from "${lateSpec}";\n` : ""}${depLines.length || lateLines.length ? `
export interface ${depsName} {
${depLines.join("\n")}${lateLines.length ? "\n  late: Late;" : ""}
}
` : ""}
export function ${hookName}(${depLines.length || lateLines.length ? `${P}: ${depsName}` : ""}) {
${body.replace(/^\n+/, "")}
  return { ${returned.join(", ")} };
}
`;
if (existsSync(outFile)) throw new Error(`${outFile} exists`);
writeFileSync(outFile, out);

// the component: the call in place of the range
const depArgs = [...deps].filter(([, i]) => !i.late).map(([n]) => n).sort();
if (lateLines.length) depArgs.push("late");
const argText = depArgs.length ? `{ ${depArgs.join(", ")} }` : "";
const call = `\n  const { ${returned.join(", ")} } = ${hookName}(${argText});`;
const callNoDestr = `\n  ${hookName}(${argText});`;
let comp2 = text.slice(0, rStart) + (returned.length ? call : callNoDestr) + text.slice(rEnd);
const hookSpec = (() => {
  let r = path.relative(path.dirname(path.resolve(file)), path.resolve(outFile)).split(path.sep).join("/").replace(/\.tsx?$/, "");
  return r.startsWith(".") ? r : "./" + r;
})();
const firstImport = comp2.search(/^import /m);
comp2 = comp2.slice(0, firstImport) + `import { ${hookName} } from "${hookSpec}";\n` + comp2.slice(firstImport);
writeFileSync(file, comp2);

// the late names this hook needs, for lib/late.ts
console.log(JSON.stringify({ out: outFile, late: lateLines.map((l) => l.trim()), returned, deps: depArgs }, null, 1));
