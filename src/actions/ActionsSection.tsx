/** Settings → Actions: the custom actions, switched on and off, edited, exported and imported. */
import { IS_MAC as MAC_KEYS } from "../components/pointer";
import { useEffect, useRef, useState } from "react";
import { Modal } from "../components/Dialogs";
import { Icon } from "../Icons";
import {
  LOCAL_LABEL,
  LOCAL_PHRASE,
  NEEDS_GIT_SH,
  comboFromEvent,
  comboLabel,
  deleteAction,
  exportActions,
  extList,
  parseImport,
  addImported,
  newId,
  previewCommand,
  saveAction,
  shortcutProblem,
  useCustomActions,
  type ActionTargets,
  type ActionWhere,
  type CustomAction,
} from "./customActions";
import { templateProblem } from "./templateCheck";
import "./actions.css";

type ToastFn = (kind: "success" | "error" | "info", text: string) => void;

const PLACEHOLDERS: { p: string; what: string }[] = [
  { p: "{path}", what: "each item (runs once per item)" },
  { p: "{paths}", what: "all items, space separated (runs once)" },
  { p: "{name}", what: "the item’s name" },
  { p: "{stem}", what: "the name without extension" },
  { p: "{ext}", what: "the extension" },
  { p: "{dir}", what: "the folder" },
];

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? "on" : ""} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const TARGETS: Record<ActionTargets, string> = { files: "Files", folders: "Folders", both: "Files and folders" };

/** "Files · jpg, png · On the server · ⇧⌘O" */
function summary(a: CustomAction) {
  const exts = a.appliesTo !== "folders" ? extList(a.extensions) : [];
  return [TARGETS[a.appliesTo] + (exts.length ? ` (${exts.join(", ")})` : ""), a.where === "server" ? "On the server" : LOCAL_LABEL, a.output === "silent" ? "Silent" : null]
    .filter(Boolean)
    .join(" · ");
}

export function ActionsSection({ onToast }: { onToast: ToastFn }) {
  const actions = useCustomActions();
  const [editing, setEditing] = useState<CustomAction | null>(null);
  const [importing, setImporting] = useState(false);

  const blank = (): CustomAction => ({
    id: newId(),
    name: "",
    command: "",
    where: "local",
    appliesTo: "files",
    extensions: "",
    output: "show",
    refresh: false,
    shortcut: null,
    enabled: true,
  });

  const doExport = async () => {
    try {
      await navigator.clipboard.writeText(exportActions());
      onToast("success", "Actions copied as JSON");
    } catch {
      onToast("error", "Could not access the clipboard");
    }
  };

  return (
    <>
      <h3 className="set-title">Actions</h3>
      <p className="ca-intro">
        Your own commands for files and folders, in the right-click menu under Actions. They run {NEEDS_GIT_SH ? `in sh ${LOCAL_PHRASE} (Git for Windows has it, install that first)` : `in your shell ${LOCAL_PHRASE}`}, or on SSH and SFTP servers. Names are always passed safely quoted.
      </p>
      <div className="set-card">
        {actions.length === 0 && <div className="set-row"><div className="set-label">No actions yet<small>Add one to run a command on the selected items.</small></div></div>}
        {actions.map((a) => {
          // saved before the check got stricter: it can't run until it's fixed
          const problem = templateProblem(a.command);
          return (
          <div key={a.id} className={`conn-row ca-row ${a.enabled && !problem ? "" : "off"}`}>
            <button
              className={`switch ${a.enabled && !problem ? "on" : ""}`}
              role="switch"
              aria-checked={a.enabled && !problem}
              aria-label={`${a.name} on`}
              disabled={!!problem}
              title={problem ? "Fix the command first" : undefined}
              onClick={() => saveAction({ ...a, enabled: !a.enabled })}
            />
            <div className="set-label">
              <span className="ca-name">
                {a.name}
                {a.shortcut && <kbd>{comboLabel(a.shortcut)}</kbd>}
              </span>
              <small>
                <code className="ca-cmd">{a.command}</code>
              </small>
              {problem && <small className="ca-bad">Can’t run: {problem}</small>}
              <small>{summary(a)}</small>
            </div>
            <button className="btn btn-sm" onClick={() => setEditing(a)}>
              Edit
            </button>
          </div>
          );
        })}
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn btn-primary btn-sm" onClick={() => setEditing(blank())}>
          <Icon name="plus" size={14} /> New action
        </button>
        <button className="btn btn-sm" onClick={() => setImporting(true)}>
          <Icon name="download" size={14} /> Import…
        </button>
        <button className="btn btn-sm" onClick={doExport} disabled={!actions.length}>
          <Icon name="upload" size={14} /> Export
        </button>
      </div>

      {editing && (
        <ActionEditor
          action={editing}
          isNew={!actions.some((a) => a.id === editing.id)}
          onClose={() => setEditing(null)}
          onSave={(a) => {
            saveAction(a);
            setEditing(null);
          }}
          onDelete={() => {
            deleteAction(editing.id);
            setEditing(null);
            onToast("info", `“${editing.name}” deleted`);
          }}
        />
      )}
      {importing && <ImportDialog onClose={() => setImporting(false)} onToast={onToast} />}
    </>
  );
}

/** Records a shortcut: the next key combination pressed while it has focus. */
function ShortcutField({ value, selfId, onChange }: { value: string | null; selfId: string; onChange: (v: string | null, problem: string | null) => void }) {
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(() => (value ? shortcutProblem(value, selfId) : null));
  return (
    <div className="ca-shortcut">
      <button
        type="button"
        className={`ca-keys ${recording ? "rec" : ""} ${problem ? "bad" : ""}`}
        onFocus={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        // Enter or Space on the button starts recording again after an Escape
        onClick={() => setRecording(true)}
        onKeyDown={(e) => {
          if (e.key === "Tab") return;
          // not recording (after an Escape): keys do their usual thing, and a second Escape reaches the editor
          if (!recording) return;
          if (e.key === "Escape" && !e.metaKey && !e.ctrlKey) {
            // stops recording only, focus stays on the button: the editor behind it must not hear this
            // Escape (it would close and drop what was typed)
            e.preventDefault();
            e.stopPropagation();
            return setRecording(false);
          }
          e.preventDefault();
          e.stopPropagation();
          if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.ctrlKey) {
            setProblem(null);
            return onChange(null, null);
          }
          const combo = comboFromEvent(e);
          if (!combo) return;
          const p = shortcutProblem(combo, selfId);
          setProblem(p);
          onChange(combo, p);
        }}
        aria-label="Shortcut"
      >
        {recording && !value ? "Press keys…" : value ? comboLabel(value) : "None"}
      </button>
      {value && (
        <button
          type="button"
          className="icon-btn"
          aria-label="Remove shortcut"
          title="Remove shortcut"
          onClick={() => {
            setProblem(null);
            onChange(null, null);
          }}
        >
          <Icon name="x" size={13} />
        </button>
      )}
      <small className={problem ? "ca-bad" : ""}>{problem ?? (recording ? `Press a key combination with ${MAC_KEYS ? "⌘" : "Ctrl"}, or an F-key. ${MAC_KEYS ? "⌫" : "Backspace"} removes it.` : "Click, then press the keys.")}</small>
    </div>
  );
}

function ActionEditor({
  action,
  isNew,
  onClose,
  onSave,
  onDelete,
}: {
  action: CustomAction;
  isNew: boolean;
  onClose: () => void;
  onSave: (a: CustomAction) => void;
  onDelete: () => void;
}) {
  const [a, setA] = useState(action);
  const [shortcutBad, setShortcutBad] = useState<string | null>(action.shortcut ? shortcutProblem(action.shortcut, action.id) : null);
  const [preview, setPreview] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cmdRef = useRef<HTMLTextAreaElement>(null);
  const set = (p: Partial<CustomAction>) => setA((cur) => ({ ...cur, ...p }));
  // Escape, the close button and Cancel ask first when something was changed: a command is costly to retype
  const [discardAsk, setDiscardAsk] = useState(false);
  const edited = JSON.stringify(a) !== JSON.stringify(action);
  const requestClose = () => (edited ? setDiscardAsk(true) : onClose());

  // what it turns into for two made-up items
  useEffect(() => {
    if (!a.command.trim()) return setPreview([]);
    const folder = a.appliesTo === "folders";
    const ext = extList(a.extensions)[0] ?? (folder ? "" : "jpg");
    const base = a.where === "server" ? "/var/www/site" : "/Users/you/Photos";
    const items = [
      { path: `${base}/${folder ? "My Folder" : `Summer trip.${ext}`}`, isDir: folder },
      { path: `${base}/${folder ? "it's here" : `it's mine.${ext}`}`, isDir: folder },
    ];
    let live = true;
    const t = setTimeout(() => {
      previewCommand(a.command, items, base)
        .then((lines) => live && setPreview(lines))
        .catch(() => live && setPreview([]));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [a.command, a.where, a.appliesTo, a.extensions]);

  const insert = (p: string) => {
    const el = cmdRef.current;
    if (!el) return set({ command: a.command + p });
    const [s, e] = [el.selectionStart, el.selectionEnd];
    const next = a.command.slice(0, s) + p + a.command.slice(e);
    set({ command: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + p.length, s + p.length);
    });
  };

  const cmdProblem = templateProblem(a.command);
  const valid = !!a.name.trim() && !!a.command.trim() && !shortcutBad && !cmdProblem;
  const save = () => valid && onSave({ ...a, name: a.name.trim(), extensions: extList(a.extensions).join(", ") });

  return (
    <>
      <Modal title={isNew ? "New action" : "Edit action"} onClose={requestClose} width={560}>
        <form
          className="modal-body ca-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label className="field">
            <span>Name</span>
            <input value={a.name} onChange={(e) => set({ name: e.target.value })} placeholder="Optimize images" autoFocus={isNew} />
          </label>
          <label className="field">
            <span>Command</span>
            <textarea
              ref={cmdRef}
              className="ca-cmd-input"
              value={a.command}
              rows={2}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => set({ command: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  save();
                }
              }}
              placeholder="sips -Z 2048 {path}"
            />
          </label>
          {cmdProblem && <p className="ca-bad">{cmdProblem}</p>}
          <div className="ca-chips" aria-label="Placeholders">
            {PLACEHOLDERS.map((x) => (
              <button key={x.p} type="button" className="chip" title={x.what} onClick={() => insert(x.p)}>
                {x.p}
              </button>
            ))}
          </div>
          {preview.length > 0 && (
            <div className="ca-preview" aria-label="Preview">
              {preview.slice(0, 2).map((l, i) => (
                <code key={i}>{l}</code>
              ))}
              <small>{preview.length > 1 ? "Runs once per item, like this." : "Runs once for all the items, like this."}</small>
            </div>
          )}

          <div className="ca-grid">
            <span className="ca-k">Runs</span>
            <div>
              <Seg<ActionWhere>
                label="Runs"
                value={a.where}
                onChange={(where) => set({ where })}
                options={[
                  { value: "local", label: LOCAL_LABEL },
                  { value: "server", label: "On the server" },
                ]}
              />
              <p className="hint">
                <Icon name="info" size={13} />
                {a.where === "local"
                  ? (NEEDS_GIT_SH ? "In sh from Git for Windows (install it first). " : "In your shell (fish and other non-POSIX shells: in sh, with their PATH). ") + "Files of a server or cloud connection are downloaded to a temporary folder first: {path} is that copy, and changes stay there."
                  : "Over SSH, in the folder on screen, with the server’s login shell. SSH and SFTP connections only."}
              </p>
            </div>

            <span className="ca-k">Applies to</span>
            <div className="ca-inline">
              <Seg<ActionTargets>
                label="Applies to"
                value={a.appliesTo}
                onChange={(appliesTo) => set({ appliesTo })}
                options={[
                  { value: "files", label: "Files" },
                  { value: "folders", label: "Folders" },
                  { value: "both", label: "Both" },
                ]}
              />
              {a.appliesTo !== "folders" && (
                <input className="ca-ext" value={a.extensions} onChange={(e) => set({ extensions: e.target.value })} placeholder="Any extension (or jpg, png)" aria-label="Extensions" />
              )}
            </div>

            <span className="ca-k">Output</span>
            <div className="ca-stack">
              <Seg
                label="Output"
                value={a.output}
                onChange={(output) => set({ output })}
                options={[
                  { value: "show", label: "Show output" },
                  { value: "silent", label: "Run silently, notify when done" },
                ]}
              />
              <label className="check">
                <input type="checkbox" checked={a.refresh} onChange={(e) => set({ refresh: e.target.checked })} />
                <span>Refresh the folder afterwards</span>
              </label>
            </div>

            <span className="ca-k">Shortcut</span>
            <ShortcutField
              value={a.shortcut}
              selfId={a.id}
              onChange={(shortcut, problem) => {
                set({ shortcut });
                setShortcutBad(problem);
              }}
            />
          </div>
          <button type="submit" hidden />
        </form>
        <div className="modal-foot split">
          <div>
            {!isNew &&
              (confirmDelete ? (
                <button className="btn btn-sm btn-danger" onClick={onDelete}>
                  Delete “{action.name}”
                </button>
              ) : (
                <button className="btn btn-sm btn-danger-ghost" onClick={() => setConfirmDelete(true)}>
                  Delete…
                </button>
              ))}
          </div>
          <div className="btn-row">
            <button className="btn btn-sm" onClick={requestClose}>
              Cancel
            </button>
            <button className="btn btn-sm btn-primary" onClick={save} disabled={!valid}>
              {isNew ? "Add action" : "Save"}
            </button>
          </div>
        </div>
      </Modal>
    {discardAsk && (
      <Modal title="Discard changes?" onClose={() => setDiscardAsk(false)} width={400}>
        <div className="modal-body">
          <p>What you typed here will be lost.</p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={() => setDiscardAsk(false)} data-autofocus>
            Keep editing
          </button>
          <button type="button" className="btn btn-danger" onClick={onClose}>
            Discard
          </button>
        </div>
      </Modal>
    )}
    </>
  );
}

function ImportDialog({ onClose, onToast }: { onClose: () => void; onToast: ToastFn }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // parsed, waiting for the user to look the commands over
  const [review, setReview] = useState<CustomAction[] | null>(null);
  const run = () => {
    try {
      setReview(parseImport(text));
    } catch (e) {
      setError(e instanceof SyntaxError ? "That isn’t valid JSON." : e instanceof Error ? e.message : String(e));
    }
  };
  if (review) {
    const add = () => {
      const n = addImported(review);
      onToast("success", n === 1 ? "1 action added, switched off" : `${n} actions added, switched off`);
      onClose();
    };
    return (
      <Modal title="Import actions" onClose={onClose} width={560}>
        <div className="modal-body ca-form">
          <p>These commands will run in a shell when you use the actions. Add them only if you trust where they came from. They are added switched off, without shortcuts: switch each on when you’ve checked it.</p>
          <div className="ca-import-list" aria-label="Actions to import">
            {review.map((a) => (
              <div key={a.id} className="ca-import-item">
                <strong>{a.name}</strong>
                <small>{a.where === "server" ? "On the server" : LOCAL_LABEL}</small>
                <code>{a.command}</code>
                {templateProblem(a.command) && <small className="ca-bad">{templateProblem(a.command)}</small>}
              </div>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-sm" onClick={() => setReview(null)}>
            Back
          </button>
          <button className="btn btn-sm btn-primary" onClick={add}>
            {review.length === 1 ? "Add 1 action" : `Add ${review.length} actions`}
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Import actions" onClose={onClose} width={520}>
      <div className="modal-body ca-form">
        <p>Paste actions exported from Kybl (Export copies them as JSON). They are added to yours.</p>
        <textarea
          className="ca-cmd-input"
          rows={8}
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          placeholder='{ "actions": [ … ] }'
          aria-label="Actions JSON"
        />
        {error && <p className="ca-bad">{error}</p>}
      </div>
      <div className="modal-foot">
        <button className="btn btn-sm" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-sm btn-primary" onClick={run} disabled={!text.trim()}>
          Import
        </button>
      </div>
    </Modal>
  );
}
