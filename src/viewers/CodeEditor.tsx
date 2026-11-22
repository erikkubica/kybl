/**
 * CodeMirror 6, set up the way Kybl needs it: syntax colours from the app's own theme tokens (so
 * light/dark follow the app with no reconfiguring), languages loaded on demand, find and replace,
 * and read-only when the file can't be edited. Shared by the text, Markdown and CSV viewers.
 */
import { useEffect, useRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";
import { coarsePointer } from "./useNarrow";

/** Colours come from CSS variables (viewers.css), defined for light and dark. */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword], color: "var(--cm-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.inserted], color: "var(--cm-string)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: "var(--cm-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--cm-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.standard(t.tagName)], color: "var(--cm-type)" },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: "var(--cm-property)" },
  { tag: [t.deleted, t.invalid], color: "var(--danger)" },
  { tag: t.heading, color: "var(--cm-keyword)", fontWeight: "700" },
  { tag: [t.heading1, t.heading2], fontSize: "1.1em" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--accent)", textDecoration: "underline" },
  { tag: [t.monospace, t.quote], color: "var(--cm-string)" },
  { tag: [t.punctuation, t.separator, t.bracket, t.processingInstruction, t.contentSeparator], color: "var(--dim)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--text)", backgroundColor: "var(--bg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--accent)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--cm-selection) !important",
  },
  ".cm-activeLine": { backgroundColor: "var(--cm-active-line)" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--faint)", borderRight: "1px solid var(--border)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--cm-active-line)", color: "var(--dim)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 10px", minWidth: "32px" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--hover)", border: "1px solid var(--border)", color: "var(--dim)" },
  ".cm-selectionMatch": { backgroundColor: "var(--cm-match)" },
  ".cm-searchMatch": { backgroundColor: "var(--cm-match)", outline: "1px solid var(--cm-match-edge)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--cm-match-edge)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--cm-match)", outline: "1px solid var(--cm-match-edge)" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-tooltip": { backgroundColor: "var(--raised)", border: "1px solid var(--border)", color: "var(--text)" },
});

/** The language for a file name; `fallback` (a language name such as "JSON") when nothing matches. */
function languageFor(name: string, fallback?: string): LanguageDescription | null {
  const base = name.slice(name.lastIndexOf("/") + 1);
  return (
    LanguageDescription.matchFilename(languages, base) ??
    (fallback ? (languages.find((l) => l.name.toLowerCase() === fallback.toLowerCase()) ?? null) : null)
  );
}

/**
 * Read-only text keeps a cursor on desktop (for find and keyboard selection), but on touch
 * screens and in the small preview it isn't focusable at all, so tapping doesn't raise the
 * keyboard. Text can still be selected and copied either way.
 */
function lock(editable: boolean, compact?: boolean): Extension {
  return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable || (!compact && !coarsePointer()))];
}

export type CodeEditorApi = {
  view: EditorView;
  /** opens the find (and replace) bar */
  find: () => void;
  /** replaces the whole text as one undoable change */
  setText: (text: string) => void;
};

export function CodeEditor({
  name,
  text,
  editable,
  compact,
  wrap,
  fallbackLanguage,
  onEdit,
  onSave,
  onReady,
}: {
  name: string;
  text: string;
  editable: boolean;
  /** side-panel preview: no gutters, smaller text */
  compact?: boolean;
  wrap?: boolean;
  fallbackLanguage?: string;
  onEdit?: (current: () => string) => void;
  onSave?: () => void;
  onReady?: (api: CodeEditorApi | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // callbacks change every render; the editor reads the latest through refs
  const cb = useRef({ onEdit, onSave });
  cb.current = { onEdit, onSave };
  const wrapping = useRef(new Compartment());
  const readOnly = useRef(new Compartment());

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const language = new Compartment();
    const ext: Extension[] = [
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightSelectionMatches(),
      search({ top: true }),
      syntaxHighlighting(highlight),
      theme,
      language.of([]),
      wrapping.current.of(wrap ? EditorView.lineWrapping : []),
      readOnly.current.of(lock(editable, compact)),
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave?.(), true) },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const state = u.state;
          cb.current.onEdit?.(() => state.doc.toString());
        }
      }),
      EditorView.contentAttributes.of({ "aria-label": `Contents of ${name}` }),
    ];
    if (!compact) ext.push(lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), foldGutter());
    const v = new EditorView({ state: EditorState.create({ doc: text, extensions: ext }), parent: el });
    view.current = v;

    // the language package loads on demand (each is its own small chunk)
    let live = true;
    const lang = languageFor(name, fallbackLanguage);
    lang
      ?.load()
      .then((support) => live && v.dispatch({ effects: language.reconfigure(support) }))
      .catch(() => {});

    onReady?.({
      view: v,
      find: () => {
        openSearchPanel(v);
      },
      setText: (next) => v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: next } }),
    });
    return () => {
      live = false;
      onReady?.(null);
      v.destroy();
      view.current = null;
    };
    // the document is created once per mount; DocumentView remounts the viewer to reload
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);
  useEffect(() => {
    view.current?.dispatch({
      effects: readOnly.current.reconfigure(lock(editable, compact)),
    });
  }, [editable, compact]);

  return <div ref={host} className={`dv-code ${compact ? "compact" : ""}`} />;
}
