/**
 * Quick Look opened on a content search hit: once the preview has the text, it scrolls to the
 * matching line and selects the match. Works on the code viewer (CodeMirror, found through its
 * DOM, so the viewers need nothing for it), the plain text preview and, by the matched text,
 * other previews (rendered Markdown, tables).
 */
import { useEffect, type RefObject } from "react";
import type { ContentHit } from "../browser/devtoolsApi";

/** how long to wait for the preview to show its text */
const TRIES = 40;
const EVERY = 150;

const matchText = (hit: ContentHit) => (hit.ranges[0] ? hit.text.slice(hit.ranges[0][0], hit.ranges[0][1]) : "");

async function inEditor(el: HTMLElement, hit: ContentHit): Promise<boolean> {
  const { EditorView } = await import("@codemirror/view");
  const view = EditorView.findFromDOM(el);
  if (!view) return false;
  const doc = view.state.doc;
  // still loading (an empty document), or the file changed since the search
  if (doc.length === 0) return false;
  const line = doc.line(Math.min(hit.line, doc.lines));
  const needle = matchText(hit);
  const at = needle ? line.text.indexOf(needle) : -1;
  const from = at >= 0 ? line.from + at : line.from;
  view.dispatch({ selection: { anchor: from, head: at >= 0 ? from + needle.length : from }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
  return true;
}

function scroller(el: HTMLElement): HTMLElement {
  for (let e: HTMLElement | null = el; e; e = e.parentElement) {
    if (e.scrollHeight > e.clientHeight + 1 && getComputedStyle(e).overflowY !== "visible") return e;
  }
  return el;
}

function inPre(pre: HTMLElement, hit: ContentHit): boolean {
  const node = [...pre.childNodes].find((n): n is Text => n.nodeType === Node.TEXT_NODE && !!n.textContent);
  if (!node) return false;
  const text = node.data;
  let start = 0;
  for (let n = 1; n < hit.line; n++) {
    const nl = text.indexOf("\n", start);
    if (nl < 0) break;
    start = nl + 1;
  }
  const end = text.indexOf("\n", start) < 0 ? text.length : text.indexOf("\n", start);
  const needle = matchText(hit);
  const at = needle ? text.slice(start, end).indexOf(needle) : -1;
  const range = document.createRange();
  range.setStart(node, at >= 0 ? start + at : start);
  range.setEnd(node, at >= 0 ? start + at + needle.length : start);
  const box = scroller(pre);
  const r = range.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  box.scrollTop += r.top - b.top - box.clientHeight / 3;
  if (at >= 0) {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  return true;
}

/**
 * Any other preview (rendered Markdown, a table): the first place the matched text shows, also
 * inside a frame of this page's own (the Markdown preview's).
 */
function inDom(el: HTMLElement, hit: ContentHit): boolean {
  const needle = matchText(hit);
  if (!needle) return false;
  const roots: [Document, Node][] = [[document, el]];
  for (const f of el.querySelectorAll("iframe")) {
    try {
      if (f.contentDocument?.body) roots.push([f.contentDocument, f.contentDocument.body]);
    } catch {
      // a frame that isn't readable from here
    }
  }
  for (const [doc, root] of roots) {
    const walk = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
      const at = n.data.indexOf(needle);
      if (at < 0) continue;
      const range = doc.createRange();
      range.setStart(n, at);
      range.setEnd(n, at + needle.length);
      n.parentElement?.scrollIntoView({ block: "center" });
      const sel = doc.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return true;
    }
  }
  return false;
}

/** Scrolls the preview inside `box` to `hit` once its text is there (for each file shown). */
export function useRevealHit(box: RefObject<HTMLElement | null>, key: string, hit: ContentHit | undefined) {
  const line = hit?.line;
  useEffect(() => {
    if (!hit) return;
    let over = false;
    let busy = false;
    let tries = 0;
    const t = window.setInterval(async () => {
      if (over || busy) return;
      if (++tries > TRIES) return stop();
      const el = box.current;
      if (!el) return;
      busy = true;
      try {
        const cm = el.querySelector<HTMLElement>(".cm-editor");
        const pre = el.querySelector<HTMLElement>("pre.ql-text");
        // a rendered document gets a moment to show before its text is looked through
        if ((cm && (await inEditor(cm, hit))) || (pre && inPre(pre, hit)) || (!cm && !pre && tries > 4 && inDom(el, hit))) stop();
      } catch {
        stop();
      } finally {
        busy = false;
      }
    }, EVERY);
    function stop() {
      over = true;
      window.clearInterval(t);
    }
    return stop;
    // the hit is read when the file opens; its object changes as results stream in
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, line]);
}
