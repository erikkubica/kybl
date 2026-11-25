// Tidies imports after code moved between files, by the compiler's own complaints: a name it
// can't find gets an import from the one module that exports it (or React's types), an import
// nothing reads goes. Repeats until there's nothing left to fix.
//
//   node scripts/refactor/fix-imports.mjs <file> [<file> …]
import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// --from <file>: where a name is ambiguous, the module that file imports it from wins
const argv = process.argv.slice(2);
const hintAt = argv.indexOf("--from");
const hintFile = hintAt >= 0 ? path.resolve(argv.splice(hintAt, 2)[1]) : null;
// --at <dir>: the folder the hint file's relative imports are from (it may be a copy elsewhere)
const atAt = argv.indexOf("--at");
const hintDir = atAt >= 0 ? path.resolve(argv.splice(atAt, 2)[1]) : hintFile && path.dirname(hintFile);
const files = argv.map((f) => path.resolve(f));
const hints = new Map();
if (hintFile) {
  const hsf = ts.createSourceFile(hintFile, readFileSync(hintFile, "utf8"), ts.ScriptTarget.Latest, true);
  for (const st of hsf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings || !ts.isNamedImports(st.importClause.namedBindings)) continue;
    const spec = st.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue;
    for (const e of st.importClause.namedBindings.elements) {
      const isType = st.importClause.isTypeOnly || e.isTypeOnly;
      hints.set(e.name.text, { abs: path.resolve(hintDir, spec), type: isType });
    }
  }
}
const cfgPath = ts.findConfigFile(".", ts.sys.fileExists, "tsconfig.json");
const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(cfgPath, ts.sys.readFile).config, ts.sys, path.dirname(cfgPath));
const REACT_VALUES = new Set(["useState", "useRef", "useEffect", "useLayoutEffect", "useCallback", "useMemo", "useSyncExternalStore", "useContext", "useReducer", "useId", "useTransition", "useDeferredValue", "createContext", "memo", "Fragment"]);
const REACT_TYPES = new Set(["RefObject", "MutableRefObject", "Dispatch", "SetStateAction", "ReactNode", "CSSProperties", "MouseEvent", "KeyboardEvent", "DragEvent", "PointerEvent", "JSX", "ReactElement"]);

// who exports what (types and values), across src
function exportIndex(program) {
  const idx = new Map();
  for (const f of program.getSourceFiles()) {
    const file = path.resolve(f.fileName);
    if (f.isDeclarationFile || !file.includes("/src/")) continue;
    ts.forEachChild(f, (n) => {
      const exported = n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) return;
      const put = (name, type) => {
        const list = idx.get(name) ?? [];
        list.push({ file, type });
        idx.set(name, list);
      };
      if (ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) put(n.name.text, true);
      else if (ts.isFunctionDeclaration(n) && n.name) put(n.name.text, false);
      else if (ts.isClassDeclaration(n) && n.name) put(n.name.text, false);
      else if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name)) put(d.name.text, false);
    });
  }
  return idx;
}

const rel = (from, to) => {
  let r = path.relative(path.dirname(from), to).split(path.sep).join("/").replace(/\.tsx?$/, "");
  return r.startsWith(".") ? r : "./" + r;
};

function addImport(src, spec, name, isType) {
  const re = new RegExp(`^import (type )?\\{([^}]*)\\} from "${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}";$`, "m");
  const m = src.match(re);
  const item = (isType && !m?.[1] ? "type " : "") + name;
  if (m) return src.replace(re, (all, t, list) => `import ${t ?? ""}{${list.trimEnd()}, ${item} } from "${spec}";`.replace("{ ,", "{"));
  const line = `import ${isType ? "type " : ""}{ ${name} } from "${spec}";\n`;
  const at = src.search(/^import /m);
  return at < 0 ? line + src : src.slice(0, at) + line + src.slice(at);
}

function removeUnused(src, sf, names) {
  // drop each unused specifier; an import left empty goes whole
  let out = src;
  const edits = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const c = st.importClause;
    const keep = [];
    let def = c.name && !names.has(c.name.text) ? c.name.text : null;
    let ns = null;
    if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) ns = names.has(c.namedBindings.name.text) ? null : c.namedBindings.name.text;
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) if (!names.has(e.name.text)) keep.push(e.getText(sf));
    const had = (c.name ? 1 : 0) + (c.namedBindings ? (ts.isNamespaceImport(c.namedBindings) ? 1 : c.namedBindings.elements.length) : 0);
    const now = (def ? 1 : 0) + (ns ? 1 : 0) + keep.length;
    if (now === had) continue;
    const spec = st.moduleSpecifier.getText(sf);
    let text = "";
    if (now) {
      const parts = [];
      if (def) parts.push(def);
      if (ns) parts.push(`* as ${ns}`);
      if (keep.length) parts.push(`{ ${keep.join(", ")} }`);
      text = `import ${c.isTypeOnly ? "type " : ""}${parts.join(", ")} from ${spec};`;
    }
    edits.push({ pos: st.getStart(sf), end: st.getEnd() + (text ? 0 : 1), text });
  }
  for (const e of edits.sort((a, b) => b.pos - a.pos)) out = out.slice(0, e.pos) + e.text + out.slice(e.end);
  return out;
}

for (let round = 0; round < 6; round++) {
  const program = ts.createProgram([...new Set([...cfg.fileNames.map((f) => path.resolve(f)), ...files])], cfg.options);
  const idx = exportIndex(program);
  let changed = false;
  for (const f of files) {
    const sf = program.getSourceFile(f);
    if (!sf) continue;
    const diags = [...program.getSemanticDiagnostics(sf), ...program.getSyntacticDiagnostics(sf)];
    let src = readFileSync(f, "utf8");
    const missing = new Map();
    const unused = new Set();
    for (const d of diags) {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      const m = msg.match(/^Cannot find name '(\w+)'/);
      if (m && (d.code === 2304 || d.code === 2552)) missing.set(m[1], true);
      if (d.code === 6133 || d.code === 6192 || d.code === 6196) {
        // only imports: an unused local is the author's to look at
        const n = sf.statements.find((st) => ts.isImportDeclaration(st) && d.start >= st.pos && d.start < st.end);
        if (n) {
          const span = sf.getFullText().slice(d.start, d.start + d.length);
          if (d.code === 6192 || span.startsWith("import")) {
            const c = n.importClause;
            if (c?.name) unused.add(c.name.text);
            if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) unused.add(c.namedBindings.name.text);
            for (const e of c?.namedBindings?.elements ?? []) unused.add(e.name.text);
          }
          else unused.add(span);
        }
      }
    }
    if (unused.size) {
      src = removeUnused(src, sf, unused);
      changed = true;
    }
    for (const name of missing.keys()) {
      if (REACT_TYPES.has(name) || REACT_VALUES.has(name)) {
        src = addImport(src, "react", name, !REACT_VALUES.has(name));
        changed = true;
        continue;
      }
      const hint = hints.get(name);
      if (hint) {
        src = addImport(src, rel(f, hint.abs), name, hint.type);
        changed = true;
        continue;
      }
      let opts = (idx.get(name) ?? []).filter((o) => o.file !== f);
      // the phone app's copy of a name is for the phone app
      if (opts.length > 1 && !f.includes("/mobile/")) opts = opts.filter((o) => !o.file.includes("/mobile/"));
      if (opts.length !== 1) {
        console.log(`${path.relative(".", f)}: '${name}' ${opts.length ? "is exported by several: " + opts.map((o) => path.relative(".", o.file)).join(", ") : "isn't exported anywhere"}`);
        continue;
      }
      src = addImport(src, rel(f, opts[0].file), name, opts[0].type);
      changed = true;
    }
    if (src !== readFileSync(f, "utf8")) writeFileSync(f, src);
  }
  if (!changed) break;
}
