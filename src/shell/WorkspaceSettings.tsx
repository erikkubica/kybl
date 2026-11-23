/**
 * A workspace's settings, in a popover under its tab (the tab's cog, or "Settings…" in its menu):
 * its name, a colour for its tab, its recipe (recipes.ts: the layout saved to reset to or open
 * again, each terminal's startup commands, opening from it when Kybl starts), and Duplicate / Close.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../Icons";
import type { PaneId } from "../browser/types";
import { WS_COLORS } from "./workspaces";

/** A workspace's recipe as the popover shows it. */
export type RecipeView = {
  /** what it opens, in a few words ("3 panes · acme, public_html, terminal") */
  summary: string;
  /** its terminals: where each opens, and its startup commands as typed (one per line) */
  terminals: { id: PaneId; label: string; startup: string }[];
  openOnLaunch: boolean;
  /** the layout on screen is the recipe (nothing to update) */
  matches: boolean;
};

export type WorkspaceSettingsProps = {
  name: string;
  color: string | null;
  /** its recipe, or null before one is saved */
  recipe: RecipeView | null;
  canClose: boolean;
  anchor: DOMRect;
  onRename: (name: string) => void;
  onColor: (color: string | null) => void;
  /** "Save layout as recipe" / "Update from layout": the recipe becomes what the workspace shows */
  onSaveRecipe: () => void;
  onResetRecipe: () => void;
  onDeleteRecipe: () => void;
  onOpenOnLaunch: (on: boolean) => void;
  onStartup: (pane: PaneId, text: string) => void;
  onDuplicate: () => void;
  onClose: () => void;
  onDismiss: () => void;
};

const WIDTH = 300;

export function WorkspaceSettings(p: WorkspaceSettingsProps) {
  const box = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(p.name);
  const nameRef = useRef(name);
  nameRef.current = name;
  const dismiss = useRef(p.onDismiss);
  dismiss.current = p.onDismiss;
  const rename = useRef(p.onRename);
  rename.current = p.onRename;
  const left = Math.max(8, Math.min(window.innerWidth - WIDTH - 8, p.anchor.left));
  const top = p.anchor.bottom + 6;

  // a name typed and then left (a click elsewhere, Escape) is kept
  const commit = () => {
    const n = nameRef.current.trim();
    if (n && n !== p.name) rename.current(n);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element;
      if (box.current?.contains(t) || t.closest?.(".ws-cog, .ctx-menu")) return;
      commitRef.current();
      dismiss.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      commitRef.current();
      dismiss.current();
    };
    const away = () => {
      commitRef.current();
      dismiss.current();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", away);
    };
  }, []);
  // the name field takes the keyboard when it opens
  useLayoutEffect(() => {
    box.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);

  return (
    <div className="ws-pop" ref={box} role="dialog" aria-label="Workspace settings" style={{ left, top, width: WIDTH }}>
      <label className="field ws-pop-name">
        <span>Name</span>
        <input
          value={name}
          maxLength={80}
          spellCheck={false}
          autoCorrect="off"
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              commit();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </label>

      <div className="ws-pop-label">Color</div>
      <div className="ws-colors" role="radiogroup" aria-label="Color">
        <button
          type="button"
          role="radio"
          aria-checked={!p.color}
          className={`ws-swatch none ${!p.color ? "on" : ""}`}
          title="No color"
          aria-label="No color"
          onClick={() => p.onColor(null)}
        />
        {WS_COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={p.color === c.id}
            className={`ws-swatch ${p.color === c.id ? "on" : ""}`}
            style={{ background: c.value }}
            title={c.label}
            aria-label={c.label}
            onClick={() => p.onColor(c.id)}
          />
        ))}
      </div>

      <div className="ws-pop-label">Recipe</div>
      {p.recipe ? (
        <div className="ws-recipe">
          <div className="ws-recipe-sum" title={p.recipe.summary}>
            <Icon name="columns" size={12} />
            <span>{p.recipe.summary}</span>
          </div>
          {p.recipe.terminals.map((t) => (
            <label key={t.id} className="ws-recipe-term">
              <span>
                <Icon name="terminal" size={11} />
                <b>{t.label}</b>
                <small>runs on start</small>
              </span>
              <textarea
                value={t.startup}
                rows={Math.min(4, Math.max(2, t.startup.split("\n").length))}
                placeholder={"One command per line, e.g.\nnpm run dev"}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                onChange={(e) => p.onStartup(t.id, e.target.value)}
              />
            </label>
          ))}
          <label className="check ws-recipe-launch">
            <input type="checkbox" checked={p.recipe.openOnLaunch} onChange={(e) => p.onOpenOnLaunch(e.target.checked)} />
            <span>Open from the recipe when Kybl starts</span>
          </label>
          <div className="ws-recipe-actions">
            <button type="button" className="btn btn-sm" onClick={p.onResetRecipe} title="Close what this workspace shows and open the recipe again">
              <Icon name="refresh" size={12} />
              Reset to recipe
            </button>
            <button type="button" className="btn btn-sm" onClick={p.onSaveRecipe} disabled={p.recipe.matches} title={p.recipe.matches ? "The recipe is what this workspace shows" : "Save the layout on screen as the recipe"}>
              Update
            </button>
            <button type="button" className="icon-btn ws-recipe-del" onClick={p.onDeleteRecipe} title="Delete recipe" aria-label="Delete recipe">
              <Icon name="trash" size={13} />
            </button>
          </div>
        </div>
      ) : (
        <div className="ws-recipe">
          <p className="ws-recipe-hint">Save the panes, folders and terminals open now, to reset to them later or open them as a new workspace from +.</p>
          <button type="button" className="btn btn-sm" onClick={p.onSaveRecipe}>
            <Icon name="plus" size={12} />
            Save layout as recipe
          </button>
        </div>
      )}

      <div className="ws-pop-foot">
        <button type="button" className="btn btn-sm" onClick={p.onDuplicate}>
          <Icon name="copy" size={12} />
          Duplicate
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger-ghost"
          onClick={p.onClose}
          disabled={!p.canClose}
          title={p.canClose ? undefined : "There is always at least one workspace"}
        >
          Close workspace
        </button>
      </div>
    </div>
  );
}
