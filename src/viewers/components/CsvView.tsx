/**
 * CSV and TSV: a table to read (parsed in a worker, rows rendered as they scroll into view) and
 * the plain text to edit. Edits made as text show up in the table when switching back.
 */
import { keys } from "../../ui/lib/osText";
import { useEffect, useMemo, useRef, useState } from "react";
import { CodeEditor, type CodeEditorApi } from "./CodeEditor";
import { DataGrid } from "./DataGrid";
import { Note, Segmented, ToolButton } from "./ui";
import type { CsvRequest, CsvResponse } from "../workers/csv.worker";
import type { ViewerProps } from "../types";

type Tab = "table" | "text";

export default function CsvView({ name, text, editable, mode, onEdit, onSave }: ViewerProps) {
  const full = mode === "full";
  const [tab, setTab] = useState<Tab>("table");
  const [parsed, setParsed] = useState<{ rows: string[][]; error: string | null; id: number } | null>(null);
  const [headerRow, setHeaderRow] = useState(true);
  const current = useRef<() => string>(() => text ?? "");
  const parsedFrom = useRef<string | null>(null);
  const editor = useRef<CodeEditorApi | null>(null);
  const worker = useRef<Worker | null>(null);
  const seq = useRef(0);
  // the editor is built the first time the text is shown (building it for a 50 MB file stalls
  // the window, and the table is what's on screen), then kept so undo history survives
  const [textUsed, setTextUsed] = useState(false);
  if (tab === "text" && !textUsed) setTextUsed(true);

  useEffect(
    () => () => {
      worker.current?.terminate();
      worker.current = null;
      // a parse in flight died with the worker (React's dev double-mount does this too)
      parsedFrom.current = null;
    },
    [],
  );

  // (re)parse when the table is shown and the text changed since the last parse
  useEffect(() => {
    if (tab !== "table") return;
    const src = current.current();
    if (parsedFrom.current === src) return;
    parsedFrom.current = src;
    worker.current ??= new Worker(new URL("../workers/csv.worker.ts", import.meta.url), { type: "module" });
    const id = ++seq.current;
    const w = worker.current;
    w.onmessage = (ev: MessageEvent<CsvResponse>) => {
      if (ev.data.id !== seq.current) return;
      setParsed({ rows: ev.data.rows, error: ev.data.error, id });
    };
    w.onerror = () => setParsed({ rows: [], error: "This file couldn't be read as a table.", id });
    const delimiter = /\.tsv$/i.test(name) ? "\t" : "";
    w.postMessage({ id, text: src, delimiter } satisfies CsvRequest);
  }, [tab, name]);

  const edited = (get: () => string) => {
    current.current = get;
    onEdit?.(get);
  };

  const rows = useMemo(() => parsed?.rows ?? [], [parsed]);
  const header = headerRow && rows.length > 1 ? rows[0] : null;
  // not a fresh array per render: the grid measures every row when its rows change
  const body = useMemo(() => (header ? rows.slice(1) : rows), [rows, header]);

  return (
    <div className="dv-viewer dv-csv">
      {full && (
        <div className="dv-tools">
          <Segmented
            label="Show as"
            value={tab}
            options={[
              { id: "table", label: "Table" },
              { id: "text", label: editable ? "Edit as text" : "Text" },
            ]}
            onChange={setTab}
          />
          {tab === "table" && <ToolButton label="First row is the header" pressed={headerRow} onClick={() => setHeaderRow((v) => !v)} />}
          {tab === "text" && <ToolButton icon="search" label="Find" onClick={() => editor.current?.find()} title={keys("Find and replace (⌘F)")} />}
          {tab === "table" && parsed?.error && (
            <span className="dv-status bad" title={parsed.error}>
              {parsed.error}
            </span>
          )}
        </div>
      )}
      {tab === "table" &&
        (parsed ? (
          rows.length ? (
            // a new parse or header choice moves the rows: the selected cell starts over
            <DataGrid key={`${parsed.id}-${header ? 1 : 0}`} label={name} rows={body} header={header} />
          ) : (
            <Note icon="text">This file is empty.</Note>
          )
        ) : (
          <Note spinner>Reading the table…</Note>
        ))}
      {full && textUsed && (
        <div className="dv-csv-text" hidden={tab !== "text"}>
          <CodeEditor
            name={name}
            text={text ?? ""}
            editable={editable}
            onEdit={edited}
            onSave={onSave}
            onReady={(api) => (editor.current = api)}
          />
        </div>
      )}
    </div>
  );
}
