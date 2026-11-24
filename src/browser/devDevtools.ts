/**
 * Browser-only stand-in (src/devMock.ts) for git status and content search: a made-up git work
 * tree at ~/Projects/kybl-web with a change of every kind, and file texts to search inside, on
 * this computer and the demo SFTP server. Never part of a release build.
 */
import { emit } from "@tauri-apps/api/event";
import type { ObjInfo } from "../types";
import type { ContentHit, ContentResult, GitChange, GitCommit, GitInfo, GitOverview } from "./devtoolsApi";

type Dir = { folders: string[]; objects: ObjInfo[] };

/** the work tree, below Home */
export const REPO = "Projects/kybl-web/";

/** The repository's folders and files (keys below Home), for the mock's tree of this computer. */
export function repoTree(file: (key: string, size: number, ageHours: number) => ObjInfo): Record<string, Dir> {
  const r = REPO;
  return {
    "Projects/": { folders: [r], objects: [] },
    [r]: {
      folders: [`${r}dist/`, `${r}node_modules/`, `${r}scratch/`, `${r}src/`],
      objects: [file(`${r}.gitignore`, 40, 900), file(`${r}CHANGELOG.md`, 2_300, 1), file(`${r}README.md`, 1_400, 300), file(`${r}TODO.md`, 220, 0.5), file(`${r}package.json`, 760, 40), file(`${r}vite.config.ts`, 380, 400)],
    },
    [`${r}src/`]: {
      folders: [`${r}src/components/`],
      objects: [file(`${r}src/api.ts`, 3_100, 2), file(`${r}src/app.ts`, 4_800, 0.2), file(`${r}src/main.ts`, 420, 700), file(`${r}src/merge.ts`, 1_900, 3), file(`${r}src/search.ts`, 2_600, 5)],
    },
    [`${r}src/components/`]: { folders: [], objects: [file(`${r}src/components/Button.tsx`, 900, 600), file(`${r}src/components/Header.tsx`, 1_300, 1)] },
    [`${r}dist/`]: { folders: [], objects: [file(`${r}dist/index.js`, 182_000, 4)] },
    [`${r}node_modules/`]: { folders: [`${r}node_modules/react/`], objects: [] },
    [`${r}node_modules/react/`]: { folders: [], objects: [file(`${r}node_modules/react/index.js`, 190, 2000)] },
    [`${r}scratch/`]: { folders: [], objects: [file(`${r}scratch/notes.md`, 300, 1)] },
  };
}

/** What git would say, relative to the top of the work tree. */
const CHANGES: GitChange[] = [
  { path: "src/app.ts", kind: "modified", staged: false, unstaged: true },
  { path: "src/api.ts", kind: "modified", staged: true, unstaged: false },
  { path: "src/components/Header.tsx", kind: "added", staged: true, unstaged: false },
  { path: "src/merge.ts", kind: "conflicted", staged: true, unstaged: true },
  { path: "src/search.ts", kind: "renamed", staged: true, unstaged: false },
  { path: "CHANGELOG.md", kind: "modified", staged: true, unstaged: true },
  { path: "README.md", kind: "deleted", staged: true, unstaged: false },
  { path: "TODO.md", kind: "untracked", staged: false, unstaged: false },
  { path: "scratch/", kind: "untracked", staged: false, unstaged: false },
  { path: "dist/", kind: "ignored", staged: false, unstaged: false },
  { path: "node_modules/", kind: "ignored", staged: false, unstaged: false },
];

const TEXT: Record<string, string> = {
  [`${REPO}src/app.ts`]: `import { search } from "./search";\nimport { api } from "./api";\n\n// TODO: debounce the search field\nexport async function start(root: HTMLElement) {\n  const results = await search("useState");\n  root.textContent = \`\${results.length} results\`;\n  const veryLongLine = "${"x".repeat(60)} useState ${"y".repeat(400)}";\n}\n`,
  [`${REPO}src/api.ts`]: `export const api = {\n  // fetch with a timeout; TODO: retry once\n  get: (url: string) => fetch(url),\n};\n`,
  [`${REPO}src/search.ts`]: `export function search(q: string) {\n  // case-insensitive, like useState in React\n  return fetch(\`/search?q=\${encodeURIComponent(q)}\`).then((r) => r.json());\n}\n`,
  [`${REPO}src/merge.ts`]: `<<<<<<< HEAD\nexport const mode = "names";\n=======\nexport const mode = "contents";\n>>>>>>> content-search\n`,
  [`${REPO}src/main.ts`]: `import { start } from "./app";\nstart(document.getElementById("root")!);\n`,
  [`${REPO}src/components/Header.tsx`]: `import { useState } from "react";\nexport function Header() {\n  const [open, setOpen] = useState(false);\n  return <header onClick={() => setOpen(!open)}>Kybl</header>;\n}\n`,
  [`${REPO}src/components/Button.tsx`]: `export function Button(p: { label: string }) {\n  return <button>{p.label}</button>;\n}\n`,
  [`${REPO}README.md`]: `# kybl-web\n\nThe website. Run \`pnpm dev\`.\n\nTODO: screenshots\n`,
  [`${REPO}TODO.md`]: `- [ ] search inside files\n- [x] git marks\n- [ ] TODO: dark mode check\n`,
  [`${REPO}CHANGELOG.md`]: `## 0.4.0\n\n- Search inside files (ripgrep)\n- Git status marks\n`,
  [`${REPO}scratch/notes.md`]: `useState vs useReducer: todo compare\n`,
  [`${REPO}.gitignore`]: `dist/\nnode_modules/\n`,
  [`${REPO}package.json`]: `{\n  "name": "kybl-web",\n  "scripts": { "dev": "vite" }\n}\n`,
  [`${REPO}vite.config.ts`]: `export default { server: { port: 5173 } };\n`,
  "notes.txt": "Groceries: rice, fish sauce\nTODO: call the landlord\n",
  "todo.md": "# Today\n\n- TODO: invoice 0042\n- reply to Anna\n",
  "README.md": "# media-prod\n\nProduction media bucket.\n\n- photos/   original uploads\n- exports/  temporary, expires after 30 days\nTODO: lifecycle rule for exports\n",
  "config.json": '{\n  "name": "media-prod",\n  "region": "nbg1",\n  "todo": "turn on versioning"\n}\n',
  "documents/notes.txt": "Meeting notes\n\nTODO: send the contract\nThe search should be case-insensitive.\n",
};

/** what the mock says about git for a folder of this computer (root, prefix) */
export function mockGitStatus(home: string, root: string, prefix: string): GitInfo | null {
  if (root !== home || !prefix.startsWith(REPO)) return null;
  const dir = prefix.slice(REPO.length);
  let inside: GitInfo["inside"] = null;
  const changes: GitChange[] = [];
  for (const c of CHANGES) {
    if (c.path.startsWith(dir) && c.path !== dir) changes.push({ ...c, path: c.path.slice(dir.length) });
    else if (c.path.endsWith("/") && dir.startsWith(c.path) && (c.kind === "ignored" || c.kind === "untracked")) inside = c.kind;
  }
  return { branch: "feature/content-search", commit: "4f2a9c1", ahead: 2, behind: 0, changes, inside, partial: false };
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const TEXTY = /\.(md|txt|ts|tsx|js|json|csv|ya?ml|toml|html|css|gitignore)$|^\.gitignore$/i;

/** A made-up overview of the mock repository: ten commits, a tracking branch, a tag, a stash. */
export function mockGitOverview(): GitOverview {
  const now = Math.floor(Date.now() / 1000);
  const log: [string, string, string, number][] = [
    ["3f9c2ab", "Tidy the settings page", "Erik", 1.5],
    ["a81d4e0", "Search: debounce the field and keep the caret where it was when results arrive", "Erik", 5],
    ["9be07c1", "Fix the merge mode name", "Sam", 26],
    ["c2d5f98", "Bump dependencies", "Erik", 70],
    ["07ab3de", "Header: open on click", "Sam", 130],
    ["e4410b7", "Add the API wrapper", "Erik", 300],
    ["5d9a2f3", "Button component", "Sam", 600],
    ["1c7e8aa", "Configure vite", "Erik", 900],
    ["f0a63b2", "Add a README", "Erik", 1500],
    ["2b8c1d4", "First commit", "Erik", 1600],
  ];
  const commits = log.map(([hash, subject, author, hours]) => ({ hash, subject, author, time: now - Math.round(hours * 3600) }));
  return {
    upstream: "origin/main",
    fetchedAt: now - 2 * 3600,
    remote: "github.com/kybl/kybl-web",
    commits,
    tag: "v0.4.0",
    stashes: 1,
  };
}

/** The mock's last commit of one file. */
export function mockGitFileCommit(file: string): GitCommit {
  const { commits } = mockGitOverview();
  return commits[file.endsWith(".md") ? 8 : 1];
}

/** A content search over the files the mock lists (`files`), streaming like the backend. */
export async function mockContentSearch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  a: any,
  files: ObjInfo[],
  engine: string,
  stopped: () => boolean,
): Promise<ContentResult> {
  let re: RegExp;
  try {
    re = new RegExp(a.regex ? a.query : a.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), a.caseSensitive ? "g" : "gi");
  } catch (e) {
    throw `That isn't a regular expression Kybl can use.\n\n${(e as Error).message}`;
  }
  const hits: ContentHit[] = [];
  let matches = 0;
  let truncated = false;
  let batch: ContentHit[] = [];
  for (const f of files) {
    const rel = f.key.slice(a.prefix.length);
    const name = f.key.split("/").pop() ?? "";
    if (!TEXTY.test(name) || (!a.hidden && rel.split("/").some((p: string) => p.startsWith(".")))) continue;
    const text = TEXT[f.key] ?? `${name}\nGenerated sample text for ${f.key}.\n`;
    let first: ContentHit | null = null;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      re.lastIndex = 0;
      if (!re.test(line)) continue;
      matches++;
      if (first) {
        first.count++;
        continue;
      }
      let shown = line.trimStart();
      if (shown.length > 240) {
        re.lastIndex = 0;
        const at = re.exec(shown)?.index ?? 0;
        const from = Math.max(0, Math.min(at - 50, shown.length - 240));
        shown = `${from > 0 ? "…" : ""}${shown.slice(from, from + 240)}${from + 240 < shown.length ? "…" : ""}`;
      }
      re.lastIndex = 0;
      const ranges = [...shown.matchAll(re)].filter((m) => m[0].length).slice(0, 20).map((m) => [m.index!, m.index! + m[0].length] as [number, number]);
      first = { key: f.key, size: f.size, modified: f.modified, line: i + 1, text: shown, ranges, count: 1 };
    }
    if (first) batch.push(first);
    if (batch.length >= 2) {
      await sleep(300);
      if (stopped()) {
        truncated = true;
        break;
      }
      hits.push(...batch);
      await emit("content-search-progress", { opId: a.opId, hits: batch, files: hits.length, matches });
      batch = [];
    }
  }
  if (!truncated && batch.length) {
    await sleep(300);
    hits.push(...batch);
    await emit("content-search-progress", { opId: a.opId, hits: batch, files: hits.length, matches });
  }
  return { hits, files: hits.length, matches, truncated, engine, unavailable: null };
}

/** `doc_open` of a file with a made-up text above: that text (so a search hit previews at its line). */
export function mockDocOpen(path: string): ArrayBuffer | undefined {
  const text = TEXT[path];
  if (text === undefined) return undefined;
  const enc = (s: string) => new TextEncoder().encode(s);
  const bytes = enc(text);
  const json = enc(JSON.stringify({ etag: `dev-${path.length}`, size: bytes.length, modified: Date.now(), contentType: "text/plain", version: null }));
  const out = new Uint8Array(4 + json.length + bytes.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  out.set(bytes, 4 + json.length);
  return out.buffer;
}
