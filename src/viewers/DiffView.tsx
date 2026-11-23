/**
 * Two texts side by side (or inline), with the changed words marked: "Compare files", Compare
 * folders' "Compare" for files that differ, and anyone else through `openDiff` (diff.ts). Syntax
 * neutral, monospace, line numbers; unchanged stretches fold away around the changes.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { docOpen, errMessage } from "../api";
import { Icon } from "../Icons";
import { formatBytes } from "../format";
import { decodeText } from "./text";
import { diffIds, tokenIds, toRows, wordDiff, type Piece, type Row } from "./myers";
import { DIFF_MAX_BYTES, type DiffSide } from "./diff";
import { eolDifference, eolOf } from "./eol";
import { Note, Segmented, ToolButton } from "./ui";
import "./viewers.css";
import "./diff.css";

/** Unchanged lines kept around each change; longer unchanged stretches fold. */
const CONTEXT = 3;
/** Rows drawn before "Show the rest" (whole-file rewrites of huge files stay responsive). */
const FIRST_ROWS = 4000;
const MAX_LINES = 250_000;
const PREFS = "kybl.diff";
const macWindow = /Macintosh|Mac OS X/.test(navigator.userAgent) && !window.matchMedia("(pointer: coarse)").matches;

type Loaded = { text: string; size: number } | { error: string };
type Prefs = { mode: "split" | "inline"; wrap: boolean; ignoreWs: boolean };

function readPrefs(): Prefs {
  try {
    return { mode: "split", wrap: false, ignoreWs: false, ...JSON.parse(localStorage.getItem(PREFS) ?? "{}") };
  } catch {
    return { mode: "split", wrap: false, ignoreWs: false };
  }
}

const nameOf = (s: DiffSide) => ("text" in s ? s.name : (s.name ?? s.key.slice(s.key.lastIndexOf("/") + 1)));
const labelOf = (s: DiffSide) => s.label ?? nameOf(s);

async function load(s: DiffSide): Promise<Loaded> {
  if ("text" in s) return { text: s.text, size: s.text.length };
  try {
    const { bytes, meta } = await docOpen(s.profileId, s.bucket, s.key, DIFF_MAX_BYTES);
    const doc = decodeText(bytes);
    // a NUL byte early on: not text (UTF-16 with a byte order mark is full of them, and is text)
    if (!doc.encoding.startsWith("utf-16") && bytes.subarray(0, 8192).includes(0))
      return { error: "This file isn’t text, so there’s nothing to compare line by line." };
    return { text: doc.text, size: meta.size >= 0 ? meta.size : bytes.length };
  } catch (e) {
    const m = errMessage(e);
    if (/too large/i.test(m)) return { error: `This file is too large to compare here. Files up to ${formatBytes(DIFF_MAX_BYTES)} can be compared.` };
    return { error: m.split("\n\n")[0] };
  }
}

const splitLines = (t: string) => {
  const lines = t.split(/\r\n|\r|\n/);
  // a final line break doesn't make an extra empty line
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** What's drawn: rows, and folded stretches of unchanged rows. */
type Item = { row: Row; i: number } | { fold: [number, number] };

export function DiffView({ left, right, title, onClose }: { left: DiffSide; right: DiffSide; title?: string; onClose: () => void }) {
  const [sides, setSides] = useState<[Loaded, Loaded] | null>(null);
  const [prefs, setPrefsState] = useState(readPrefs);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [all, setAll] = useState(false);
  const [at, setAt] = useState(-1);
  const body = useRef<HTMLDivElement>(null);
  const setPrefs = (p: Partial<Prefs>) =>
    setPrefsState((cur) => {
      const n = { ...cur, ...p };
      try {
        localStorage.setItem(PREFS, JSON.stringify(n));
      } catch {
        /* ignore */
      }
      return n;
    });

  useEffect(() => {
    let live = true;
    void Promise.all([load(left), load(right)]).then((s) => live && setSides(s));
    return () => {
      live = false;
    };
  }, [left, right]);

  const texts = sides && "text" in sides[0] && "text" in sides[1] ? ([sides[0].text, sides[1].text] as const) : null;
  const diff = useMemo(() => {
    if (!texts) return null;
    const a = splitLines(texts[0]);
    const b = splitLines(texts[1]);
    if (a.length > MAX_LINES || b.length > MAX_LINES) return { tooMany: true as const };
    const norm = prefs.ignoreWs ? (s: string) => s.replace(/\s+/g, " ").trim() : undefined;
    const [ia, ib] = tokenIds(a, b, norm);
    const rows = toRows(diffIds(ia, ib));
    // with whitespace ignored, lines that differ only in spaces count as the same
    let added = 0;
    let removed = 0;
    const hunks: number[] = [];
    rows.forEach((r, i) => {
      if (r.t === "same") return;
      if (r.t !== "add") removed++;
      if (r.t !== "del") added++;
      if (i === 0 || rows[i - 1].t === "same") hunks.push(i);
    });
    const sameText = texts[0] === texts[1];
    const eolNote = sameText || hunks.length ? "" : eolDifference(texts[0], texts[1]);
    return { a, b, rows, hunks, added, removed, eol: [eolOf(texts[0]), eolOf(texts[1])] as const, sameText, eolNote };
  }, [texts?.[0], texts?.[1], prefs.ignoreWs]); // eslint-disable-line react-hooks/exhaustive-deps

  // folds: unchanged stretches longer than the context on both sides
  const items = useMemo((): Item[] => {
    if (!diff || "tooMany" in diff) return [];
    const out: Item[] = [];
    const { rows } = diff;
    let i = 0;
    while (i < rows.length) {
      if (rows[i].t !== "same") {
        out.push({ row: rows[i], i });
        i++;
        continue;
      }
      let j = i;
      while (j < rows.length && rows[j].t === "same") j++;
      const from = i === 0 ? 0 : i + CONTEXT;
      const to = j === rows.length ? j : j - CONTEXT;
      if (to - from > 1 && !open.has(i)) {
        for (let k = i; k < from; k++) out.push({ row: rows[k], i: k });
        out.push({ fold: [from, to] });
        for (let k = to; k < j; k++) out.push({ row: rows[k], i: k });
      } else for (let k = i; k < j; k++) out.push({ row: rows[k], i: k });
      i = j;
    }
    return out;
  }, [diff, open]);

  const words = useRef(new Map<number, [Piece[], Piece[]]>());
  useEffect(() => {
    words.current.clear();
    // a new diff (Ignore whitespace switched): the current change and the opened folds were
    // row indexes into the old one
    setAt(-1);
    setOpen(new Set());
    setAll(false);
  }, [diff]);
  const pieces = (i: number, a: string, b: string) => {
    let w = words.current.get(i);
    if (!w) words.current.set(i, (w = wordDiff(a, b)));
    return w;
  };

  const hunks = diff && !("tooMany" in diff) ? diff.hunks : [];
  const jump = (to: number) => {
    if (!hunks.length) return;
    const n = (to + hunks.length) % hunks.length;
    setAt(n);
    const row = hunks[n];
    // a change past what's drawn so far: draw everything first
    const shown = items.findIndex((it) => "row" in it && it.i === row);
    if (shown < 0 || shown >= FIRST_ROWS) setAll(true);
    requestAnimationFrame(() => body.current?.querySelector(`[data-row="${row}"]`)?.scrollIntoView({ block: "center" }));
  };
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  const atRef = useRef(at);
  atRef.current = at;

  useEffect(() => {
    // the viewer owns the keyboard: the app underneath hears nothing (scrolling and copying,
    // the browser's own, still work)
    const onKey = (ev: KeyboardEvent) => {
      const k = ev.key;
      const plain = !ev.metaKey && !ev.ctrlKey && !ev.altKey;
      if (k === "Escape") {
        ev.preventDefault();
        onClose();
      } else if (k === "F7" || (plain && (k === "n" || k === "p"))) {
        ev.preventDefault();
        jumpRef.current(atRef.current + (ev.shiftKey || k === "p" ? -1 : 1));
      }
      ev.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    body.current?.focus();
  }, [diff]);

  const inline = prefs.mode === "inline";
  const shownItems = all ? items : items.slice(0, FIRST_ROWS);
  const errors = sides?.map((s) => ("error" in s ? s.error : null));

  const cell = (text: string | undefined, ps: Piece[] | null, cls: string) => (
    <div className={`dif-code ${cls}`}>
      {ps ? ps.map((p, k) => (p.on ? <mark key={k}>{p.text}</mark> : <Fragment key={k}>{p.text}</Fragment>)) : text || "​"}
    </div>
  );
  const num = (n: number | null, cls = "") => <div className={`dif-num ${cls}`}>{n === null ? "" : n + 1}</div>;

  const renderRow = (r: Row, i: number) => {
    const d = diff as Exclude<typeof diff, null | { tooMany: true }>;
    if (inline) {
      if (r.t === "same")
        return (
          <div className="dif-row" key={i} data-row={i}>
            {num(r.a)}
            {num(r.b)}
            <div className="dif-sign" />
            {cell(d.a[r.a], null, "")}
          </div>
        );
      const w = r.t === "chg" ? pieces(i, d.a[r.a], d.b[r.b]) : null;
      return (
        <div className="dif-group" key={i} data-row={i}>
          {r.t !== "add" && (
            <div className="dif-row del">
              {num(r.a)}
              {num(null)}
              <div className="dif-sign">−</div>
              {cell(d.a[r.a], w?.[0] ?? null, "")}
            </div>
          )}
          {r.t !== "del" && (
            <div className="dif-row add">
              {num(null)}
              {num(r.b)}
              <div className="dif-sign">+</div>
              {cell(d.b[r.b], w?.[1] ?? null, "")}
            </div>
          )}
        </div>
      );
    }
    const w = r.t === "chg" ? pieces(i, d.a[r.a], d.b[r.b]) : null;
    const a = r.t === "add" ? null : r.a;
    const b = r.t === "del" ? null : r.b;
    const lc = r.t === "same" ? "" : a === null ? "none" : "del";
    const rc = r.t === "same" ? "" : b === null ? "none" : "add";
    return (
      <div className="dif-row" key={i} data-row={i}>
        {num(a, lc)}
        {cell(a === null ? undefined : d.a[a], w?.[0] ?? null, lc)}
        {num(b, `${rc} dif-mid`)}
        {cell(b === null ? undefined : d.b[b], w?.[1] ?? null, rc)}
      </div>
    );
  };

  let content: React.ReactNode;
  if (!sides) content = <Note spinner>Loading both files…</Note>;
  else if (errors?.some(Boolean))
    content = (
      <Note icon="alert">
        {errors!.map((e, k) => e && <p key={k}>{`${labelOf(k ? right : left)}: ${e}`}</p>)}
      </Note>
    );
  else if (!diff) content = <Note spinner>Comparing…</Note>;
  else if ("tooMany" in diff) content = <Note icon="alert">These files have too many lines to compare here (over {MAX_LINES.toLocaleString()}).</Note>;
  else if (!diff.hunks.length)
    content = (
      <Note icon="check-circle">
        <p>
          <strong>{diff.sameText ? "The files are identical." : "No differences."}</strong>
        </p>
        {!diff.sameText && <p>{prefs.ignoreWs ? "They differ only in spaces and tabs." : diff.eolNote}</p>}
      </Note>
    );
  else
    content = (
      <div className={`dif-body ${inline ? "dif-inline" : "dif-split"} ${prefs.wrap ? "dif-wrap" : ""}`} ref={body} tabIndex={-1}>
        {!inline && (
          <div className="dif-row dif-heads">
            <div className="dif-head" title={labelOf(left)}>
              {labelOf(left)}
            </div>
            <div className="dif-head" title={labelOf(right)}>
              {labelOf(right)}
            </div>
          </div>
        )}
        {shownItems.map((it) =>
          "fold" in it ? (
            <button
              type="button"
              key={`f${it.fold[0]}`}
              className="dif-fold"
              onClick={() => setOpen((o) => new Set(o).add(it.fold[0] === 0 ? 0 : it.fold[0] - CONTEXT))}
            >
              <Icon name="chevron-down" size={12} /> {(it.fold[1] - it.fold[0]).toLocaleString()} unchanged lines
            </button>
          ) : (
            renderRow(it.row, it.i)
          ),
        )}
        {!all && items.length > FIRST_ROWS && (
          <button type="button" className="dif-fold" onClick={() => setAll(true)}>
            Show the remaining {(items.length - FIRST_ROWS).toLocaleString()} lines
          </button>
        )}
      </div>
    );

  const ready = diff && !("tooMany" in diff) && diff.hunks.length > 0;
  return (
    <div className={`dv dv-full dif ${macWindow ? "mac" : ""}`} role="dialog" aria-modal="true" aria-label="Compare files">
      <header className="dv-bar" data-tauri-drag-region>
        <button type="button" className="dv-icon" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <Icon name="x" size={16} />
        </button>
        <div className="dv-title" data-tauri-drag-region>
          <div className="dv-name">{title ?? (nameOf(left) === nameOf(right) ? `Compare “${nameOf(left)}”` : `${nameOf(left)} ↔ ${nameOf(right)}`)}</div>
          <div className="dv-sub">
            {ready ? (
              <>
                <span className="dif-stat add">+{diff.added.toLocaleString()}</span> <span className="dif-stat del">−{diff.removed.toLocaleString()}</span> · {diff.hunks.length === 1 ? "1 change" : `${diff.hunks.length.toLocaleString()} changes`}
                {diff.eol[0] && diff.eol[1] && diff.eol[0] !== diff.eol[1] && ` · line endings ${diff.eol[0]} / ${diff.eol[1]}`}
              </>
            ) : (
              `${labelOf(left)} · ${labelOf(right)}`
            )}
          </div>
        </div>
      </header>
      <div className="dv-tools">
        <Segmented
          label="Layout"
          value={prefs.mode}
          options={[
            { id: "split", label: "Side by side" },
            { id: "inline", label: "Inline" },
          ]}
          onChange={(mode) => setPrefs({ mode })}
        />
        <ToolButton icon="list" label="Wrap" title="Wrap long lines" pressed={prefs.wrap} onClick={() => setPrefs({ wrap: !prefs.wrap })} />
        <ToolButton label="Ignore whitespace" pressed={prefs.ignoreWs} onClick={() => setPrefs({ ignoreWs: !prefs.ignoreWs })} />
        <span className="dif-gap" />
        <span className="dif-pos">{ready ? (at >= 0 ? `${at + 1} of ${hunks.length}` : `${hunks.length} changes`) : ""}</span>
        <ToolButton icon="arrow-up" label="Previous" title="Previous change (⇧F7 or p)" disabled={!ready} onClick={() => jump(at - 1)} />
        <ToolButton icon="arrow-down" label="Next" title="Next change (F7 or n)" disabled={!ready} onClick={() => jump(at + 1)} />
      </div>
      <div className="dv-body">{content}</div>
    </div>
  );
}

/** Puts a diff over the window; the returned function takes it down again. */
export function mountDiff(left: DiffSide, right: DiffSide, opts: { title?: string }, onClosed: () => void): () => void {
  const host = document.createElement("div");
  // the shell sees an overlay and keeps its shortcuts and drops to itself (shell overlayUp)
  host.className = "modal-backdrop dif-host";
  document.body.appendChild(host);
  const before = document.activeElement as HTMLElement | null;
  const root = createRoot(host);
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    root.unmount();
    host.remove();
    onClosed();
    before?.focus?.();
  };
  root.render(<DiffView left={left} right={right} title={opts.title} onClose={close} />);
  return close;
}
