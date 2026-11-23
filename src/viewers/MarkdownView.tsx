/**
 * Markdown: the source in the editor, the rendered page beside it (or one at a time on narrow
 * screens). The rendered HTML is cleaned with DOMPurify and shown only inside SandboxFrame.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Marked } from "marked";
import { headingSlugger, htmlText } from "./slug";
import DOMPurify from "dompurify";
import { CodeEditor, type CodeEditorApi } from "./CodeEditor";
import { SandboxFrame } from "./SandboxFrame";
import { Segmented, ToolButton } from "./ui";
import { useNarrow } from "./useNarrow";
import type { ViewerProps } from "./types";
import { formatBytes } from "../format";

type Layout = "edit" | "split" | "preview";

/** Above this many characters the preview is drawn on request only (see `big` below). */
export const RENDER_MAX = 512 * 1024;

export function renderMarkdown(src: string): string {
  // headings get GitHub's ids, so a table of contents' #links work
  const slug = headingSlugger();
  const md = new Marked({
    gfm: true,
    async: false,
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        return `<h${depth} id="${slug(htmlText(inner))}">${inner}</h${depth}>\n`;
      },
    },
  });
  const html = md.parse(src) as string;
  // ids and names come out as "user-content-…" (as on GitHub), so none can stand for a document
  // property; SandboxFrame looks anchors up with that prefix too
  return DOMPurify.sanitize(html, { FORCE_BODY: true, SANITIZE_NAMED_PROPS: true, FORBID_TAGS: ["form", "input", "button", "textarea", "select"] });
}

/** Whether rendered HTML shows an image from the web (an <img> or a srcset with an http(s) address). */
export const hasRemoteImages = (html: string) => /<img\b[^>]*\b(src|srcset)\s*=\s*["']?[^"'>]*https?:/i.test(html);

const CSS = `
body{padding:20px 24px 40px;font-size:15px;line-height:1.6;max-width:860px;margin:0 auto;word-wrap:break-word}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.4em 0 .6em;font-weight:650}
h1{font-size:1.9em;padding-bottom:.3em;border-bottom:1px solid var(--border)}
h2{font-size:1.45em;padding-bottom:.25em;border-bottom:1px solid var(--border)}
h3{font-size:1.2em}
body>:first-child{margin-top:0}
p,ul,ol,blockquote,pre,table{margin:0 0 1em}
code,pre{font-family:var(--mono);font-size:.88em}
code{background:var(--code);padding:.15em .35em;border-radius:5px}
pre{background:var(--panel);border:1px solid var(--border);padding:12px 14px;border-radius:8px;overflow:auto}
pre code{background:none;padding:0}
blockquote{margin-left:0;padding:0 1em;color:var(--dim);border-left:3px solid var(--border)}
table{border-collapse:collapse;display:block;overflow:auto}
th,td{border:1px solid var(--border);padding:6px 12px}
th{background:var(--panel);font-weight:600}
img{max-width:100%}
hr{border:0;border-top:1px solid var(--border);margin:1.6em 0}
li+li{margin-top:.25em}
input[type=checkbox]{margin-right:.4em}
@media (max-width:600px){body{padding:16px 16px 32px}}
`;

export default function MarkdownView({ name, text, editable, mode, onEdit, onSave }: ViewerProps) {
  const full = mode === "full";
  const narrow = useNarrow();
  // phones open on the rendered page (reading is the common case); "Edit" is one tap away
  const [layout, setLayout] = useState<Layout>(() => (!full || !editable || narrow ? "preview" : "split"));
  const [source, setSource] = useState(text ?? "");
  const editor = useRef<CodeEditorApi | null>(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  // phones have no room for two panes
  const shown: Layout = narrow && layout === "split" ? "edit" : layout;
  // Rendering runs on the UI thread: above RENDER_MAX it would freeze the window for seconds on
  // every pause in typing, so a big file shows as text until "Render preview", and that rendered
  // copy is only redrawn on "Update preview"
  const big = source.length > RENDER_MAX;
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const toRender = shown === "edit" ? null : big ? snapshot : source;
  const html = useMemo(() => (toRender == null ? "" : renderMarkdown(toRender)), [toRender]);
  // remote images tell their server the file was opened (and from where): only when asked, per file
  const [remoteOk, setRemoteOk] = useState(false);
  const hasRemote = useMemo(() => hasRemoteImages(html), [html]);

  const edited = (current: () => string) => {
    onEdit?.(current);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSource(current()), 250);
  };

  const options: { id: Layout; label: string }[] = narrow
    ? [
        { id: "edit", label: "Edit" },
        { id: "preview", label: "Preview" },
      ]
    : [
        { id: "edit", label: "Edit" },
        { id: "split", label: "Side by side" },
        { id: "preview", label: "Preview" },
      ];

  return (
    <div className="dv-viewer dv-md">
      {full && (
        <div className="dv-tools">
          {editable ? (
            <Segmented label="Layout" value={shown} options={options} onChange={setLayout} />
          ) : (
            <Segmented
              label="Layout"
              value={shown === "preview" ? "preview" : "edit"}
              options={[
                { id: "preview", label: "Preview" },
                { id: "edit", label: "Source" },
              ]}
              onChange={setLayout}
            />
          )}
          {shown !== "preview" && <ToolButton icon="search" label="Find" onClick={() => editor.current?.find()} title="Find and replace (⌘F)" />}
          {big && shown !== "edit" && snapshot != null && snapshot !== source && (
            <ToolButton icon="refresh" label="Update preview" title="Large file: the preview isn't redrawn while you type" onClick={() => setSnapshot(source)} />
          )}
        </div>
      )}
      {hasRemote && !remoteOk && shown !== "edit" && (
        <div className="dv-banner">
          <span>Remote images are not loaded, so their servers can’t tell that this file was opened.</span>
          <button className="btn btn-sm" onClick={() => setRemoteOk(true)}>
            Load remote images
          </button>
        </div>
      )}
      <div className={`dv-md-panes ${shown}`}>
        {/* the editor stays mounted while hidden, so undo history and cursor survive switching */}
        {full && (
          <div className="dv-md-source" hidden={shown === "preview"}>
            <CodeEditor
              name={name}
              text={text ?? ""}
              editable={editable}
              wrap
              fallbackLanguage="Markdown"
              onEdit={edited}
              onSave={onSave}
              onReady={(api) => (editor.current = api)}
            />
          </div>
        )}
        {shown !== "edit" &&
          (big && snapshot == null ? (
            <div className="dv-md-big">
              <div className="dv-md-bigbar">
                <span>Large file ({formatBytes(source.length)}), shown as text.</span>
                <ToolButton label="Render preview" title="Draw the formatted page (may take a few seconds)" onClick={() => setSnapshot(source)} />
              </div>
              <pre className="dv-md-text selectable">{source}</pre>
            </div>
          ) : (
            <SandboxFrame className="dv-md-preview" title={`Preview of ${name}`} html={html} css={CSS} remoteImages={remoteOk} />
          ))}
      </div>
    </div>
  );
}
