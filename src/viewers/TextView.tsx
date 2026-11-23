/** Plain text, code, YAML and JSON (with Format and a validity check). */
import { keys } from "../components/osText";
import { useEffect, useRef, useState } from "react";
import { CodeEditor, type CodeEditorApi } from "./CodeEditor";
import { ToolButton } from "./ui";
import { compactJson, formatJson } from "./jsonFormat";
import { describeJsonError } from "./jsonCheck";
import type { ViewerProps } from "./types";

type JsonState = { ok: true } | { ok: false; message: string } | null;

/** JSON Lines files are one JSON value per line, so they validate line by line. */
function checkJson(text: string, lines: boolean): JsonState {
  if (!text.trim()) return null;
  if (lines) {
    const all = text.split("\n");
    for (let i = 0; i < all.length; i++) {
      if (!all[i].trim()) continue;
      try {
        JSON.parse(all[i]);
      } catch (e) {
        return { ok: false, message: describeJsonError(all[i], (e as Error).message, i + 1) };
      }
    }
    return { ok: true };
  }
  try {
    JSON.parse(text);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: describeJsonError(text, (e as Error).message) };
  }
}

/** Keeps the file's own indentation width when formatting (2 spaces when it has none). */
function indentOf(text: string): string | number {
  const m = /\n([ \t]+)\S/.exec(text);
  if (!m) return 2;
  return m[1].startsWith("\t") ? "\t" : Math.min(8, m[1].length);
}

export default function TextView({ kind, name, text, editable, mode, onEdit, onSave }: ViewerProps) {
  const full = mode === "full";
  const editor = useRef<CodeEditorApi | null>(null);
  const [wrap, setWrap] = useState(() => kind !== "json" && /\.(txt|log|md|text|srt|vtt)$|^[^.]*$/i.test(name));
  const isJson = kind === "json";
  const jsonLines = /\.(jsonl|ndjson)$/i.test(name);
  const [json, setJson] = useState<JsonState>(() => (isJson && full ? checkJson(text ?? "", jsonLines) : null));
  const timer = useRef(0);

  useEffect(() => () => clearTimeout(timer.current), []);

  const edited = (current: () => string) => {
    onEdit?.(current);
    if (!isJson || !full) return;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setJson(checkJson(current(), jsonLines)), 400);
  };

  const format = () => {
    const ed = editor.current;
    if (!ed) return;
    const src = ed.view.state.doc.toString();
    try {
      // validate with JSON.parse, but re-indent the original text so numbers and key order stay as written
      const valid = (s: string) => (JSON.parse(s), s);
      const out = jsonLines
        ? src
            .split("\n")
            .map((l) => (l.trim() ? compactJson(valid(l)) : l))
            .join("\n")
        : formatJson(valid(src), indentOf(src)) + (src.endsWith("\n") ? "\n" : "");
      if (out !== src) ed.setText(out);
    } catch (e) {
      setJson({ ok: false, message: describeJsonError(src, (e as Error).message) });
    }
  };

  return (
    <div className="dv-viewer dv-text">
      {full && (
        <div className="dv-tools">
          <ToolButton icon="search" label="Find" onClick={() => editor.current?.find()} title={keys("Find and replace (⌘F)")} />
          <ToolButton label="Wrap lines" pressed={wrap} onClick={() => setWrap((w) => !w)} />
          {isJson && editable && <ToolButton label={jsonLines ? "Tidy lines" : "Format"} onClick={format} disabled={json?.ok === false} />}
          {isJson && json && (
            <span className={`dv-status ${json.ok ? "ok" : "bad"}`} title={json.ok ? undefined : json.message}>
              {json.ok ? "Valid JSON" : json.message}
            </span>
          )}
        </div>
      )}
      <CodeEditor
        name={name}
        text={text ?? ""}
        editable={editable}
        compact={!full}
        wrap={wrap || !full}
        fallbackLanguage={isJson ? "JSON" : undefined}
        onEdit={edited}
        onSave={onSave}
        onReady={(api) => (editor.current = api)}
      />
    </div>
  );
}
