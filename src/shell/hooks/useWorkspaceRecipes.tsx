/**
 * The shell's side of workspace recipes (recipes.ts): saving a workspace's layout as its recipe,
 * resetting a workspace to it, opening a new workspace from one ("+" and ⌘K), a workspace that
 * opens from its recipe when Kybl starts, and the note an empty pane shows when its connection
 * isn't on this device. The shell hands in what it owns through `host` on each render.
 */
import { useEffect, useRef, useState } from "react";
import { baseName } from "../../core/format";
import { LOCAL_PROFILE, type PaneId } from "../../browser/types";
import type { Profile } from "../../core/types";
import type { Dialogs } from "./useDialogs";
import { registerCommands } from "../../palette/lib/commands";
import { newSid, setStartup, terminalBusy } from "../../terminal/api";
import { leaves } from "../lib/paneLayout";
import { captureRecipe, freeName, layoutOnly, matchesRecipe, openRecipe, recipeId, terminalPanes, type OpenedRecipe, type Recipe } from "../lib/recipes";
import { useRecipes } from "./useRecipes";
import { newId, type Layout, type Workspace, type WorkspaceStore } from "../lib/workspaces";
import type { RecipeView } from "../components/WorkspaceSettings";

export type RecipeHost = {
  ws: WorkspaceStore;
  /** a workspace's layout: the one on screen as it is now */
  layoutOf: (id: string) => Layout;
  profiles: Profile[];
  rootLabel: (profileId: string, bucket: string) => string;
  /** shows `l` as workspace `id` in place of what it showed (`empty`: panes that stay empty) */
  show: (id: string, l: Layout, empty: Set<PaneId>) => void;
  /** adds workspace `w` after the others and shows it */
  add: (w: Workspace, empty: Set<PaneId>) => void;
  patch: (id: string, patch: Partial<Pick<Workspace, "start" | "recipe">>) => void;
  newEmpty: () => void;
  /** a copy of the workspace on screen, its layout and places */
  duplicate: () => void;
  confirm: Dialogs["confirm"];
  menu: Dialogs["menu"];
  toast: Dialogs["toast"];
};

type Notes = Partial<Record<PaneId, string>>;

/** The startup lines of a recipe just opened go to its terminals' sessions, typed once each shell is up. */
const arm = (o: OpenedRecipe) => o.startups.forEach(([sid, lines]) => setStartup(sid, lines));

export function useWorkspaceRecipes() {
  const [recipes, setRecipes] = useRecipes();
  /** panes on screen left empty because their connection is gone: its name */
  const [notes, setNotes] = useState<Notes>({});
  const host = useRef<RecipeHost | null>(null);
  const recipeOf = (w: Pick<Workspace, "recipe"> | null | undefined, list = recipes) => (w?.recipe ? (list.find((r) => r.id === w.recipe) ?? null) : null);
  const known = () => {
    const ids = new Set([LOCAL_PROFILE, ...(host.current?.profiles ?? []).map((p) => p.id)]);
    return (id: string) => ids.has(id);
  };
  const emptyOf = (o: OpenedRecipe) => new Set(Object.keys(o.missing) as PaneId[]);

  /** On launch (before the connections are read): each workspace set to open from its recipe does. */
  const atLaunch = (s: WorkspaceStore): WorkspaceStore => ({
    ...s,
    list: s.list.map((w) => {
      const r = w.start === "saved" ? recipeOf(w) : null;
      if (!r) return w;
      const o = openRecipe(r.layout, newSid, null);
      arm(o);
      return { ...w, ...o.layout };
    }),
  });
  /** Once the connections are read at launch: the panes of workspace `w` (opened from its recipe) whose connection is gone. */
  const missingAtLaunch = (w: Workspace, isKnown: (id: string) => boolean): Notes => {
    const r = w.start === "saved" ? recipeOf(w) : null;
    if (!r) return {};
    const o = openRecipe(r.layout, () => "", isKnown);
    setNotes(o.missing);
    return o.missing;
  };

  const save = (wsId: string) => {
    const h = host.current;
    const w = h?.ws.list.find((x) => x.id === wsId);
    if (!h || !w) return;
    const connName = (id: string) => h.profiles.find((p) => p.id === id)?.name;
    const r = recipeOf(w);
    const layout = captureRecipe(h.layoutOf(wsId), connName, r?.layout);
    if (r) {
      setRecipes((cur) => cur.map((x) => (x.id === r.id ? { ...x, layout } : x)));
      h.toast("success", `Updated the recipe “${r.name}”`);
    } else {
      const id = recipeId();
      setRecipes((cur) => [...cur, { id, name: w.name, color: w.color, layout }]);
      h.patch(wsId, { recipe: id });
      h.toast("success", `Saved “${w.name}” as a recipe`);
    }
  };

  /** "Reset to recipe": what workspace `wsId` shows closes and its recipe opens anew (asking first when terminals would end). */
  const reset = async (wsId: string) => {
    const h = host.current;
    const w = h?.ws.list.find((x) => x.id === wsId);
    const r = recipeOf(w);
    if (!h || !w || !r) return;
    // (layout only: an Undo must not take back a rename or recolor made meanwhile)
    const now = layoutOnly(h.layoutOf(wsId));
    const terms = terminalPanes(now);
    if (terms.length) {
      const busy = (await Promise.all(terms.map((id) => (now.panes[id]?.term?.sid ? terminalBusy(now.panes[id]!.term!.sid!) : null)))).filter((b) => b).length;
      const n = terms.length;
      const ok = await h.confirm({
        title: `Reset “${w.name}” to its recipe?`,
        label: "Reset",
        message: (
          <p>
            {n === 1 ? "Its terminal closes" : `Its ${n} terminals close`}
            {busy ? (busy === 1 && n === 1 ? ", and what runs in it stops" : `, and what runs in ${busy === 1 ? "one of them" : busy === n ? "them" : `${busy} of them`} stops`) : ""}.{" "}
            {wsId === h.ws.active ? "The recipe’s panes and terminals open again" : "It opens with the recipe’s panes and terminals"}, and its startup commands run.
          </p>
        ),
      });
      if (!ok) return;
    }
    const o = openRecipe(r.layout, newSid, known());
    arm(o);
    host.current!.show(wsId, o.layout, emptyOf(o));
    setNotes(o.missing);
    // without terminals nothing was asked: Undo brings the layout back as it was (ended shells can't come back)
    const undo = terms.length
      ? undefined
      : {
          label: "Undo",
          run: () => {
            if (host.current?.ws.list.some((x) => x.id === wsId)) host.current.show(wsId, now, new Set());
          },
        };
    h.toast("info", `Reset “${w.name}” to its recipe`, undo);
  };

  /** A new workspace from recipe `r`, its terminals running their startup commands. */
  const openNew = (r: Recipe) => {
    const h = host.current;
    if (!h) return;
    const o = openRecipe(r.layout, newSid, known());
    arm(o);
    const w: Workspace = { ...o.layout, id: newId(), name: freeName(h.ws.list.map((x) => x.name), r.name), color: r.color, start: "restore", recipe: r.id };
    h.add(w, emptyOf(o));
    setNotes(o.missing);
  };

  /** Deletes recipe `rId` (its workspaces stay as they are, without one); Undo brings it back. */
  const remove = (rId: string) => {
    const h = host.current;
    const r = recipes.find((x) => x.id === rId);
    if (!h || !r) return;
    const linked = h.ws.list.filter((w) => w.recipe === rId).map((w) => ({ id: w.id, start: w.start }));
    setRecipes((cur) => cur.filter((x) => x.id !== rId));
    for (const w of linked) h.patch(w.id, { recipe: null, start: "restore" });
    h.toast("info", `Deleted the recipe “${r.name}”`, {
      label: "Undo",
      run: () => {
        setRecipes((cur) => (cur.some((x) => x.id === rId) ? cur : [...cur, r]));
        for (const w of linked) host.current?.patch(w.id, { recipe: rId, start: w.start });
      },
    });
  };

  const setLines = (rId: string, pane: PaneId, text: string) =>
    setRecipes((cur) =>
      cur.map((r) => {
        const p = r.layout.panes[pane];
        if (r.id !== rId || !p?.term) return r;
        return { ...r, layout: { ...r.layout, panes: { ...r.layout.panes, [pane]: { ...p, startup: text ? text.split("\n") : [] } } } };
      }),
    );

  /** A workspace renamed: its recipe keeps the same name when it had it. */
  const renamed = (wsId: string, before: string, after: string) => {
    const r = recipeOf(host.current?.ws.list.find((w) => w.id === wsId));
    if (r && r.name === before) setRecipes((cur) => cur.map((x) => (x.id === r.id ? { ...x, name: after } : x)));
  };

  /** What workspace `wsId`'s settings show of its recipe. */
  const view = (wsId: string): RecipeView | null => {
    const h = host.current;
    const w = h?.ws.list.find((x) => x.id === wsId);
    const r = recipeOf(w);
    if (!h || !w || !r) return null;
    const where = (at: { profileId: string; bucket: string; prefix: string }, conn?: string) => {
      const sub = at.prefix.replace(/\/+$/, "");
      const prof = at.profileId === LOCAL_PROFILE || h.profiles.some((p) => p.id === at.profileId);
      if (sub) return baseName(sub);
      // (a connection that is gone: by the name it had)
      if (!prof) return conn || "gone";
      return h.rootLabel(at.profileId, at.bucket) || h.profiles.find((p) => p.id === at.profileId)?.name || conn || at.bucket || "/";
    };
    const label = (id: PaneId) => `Terminal · ${where(r.layout.panes[id]!.term!)}`;
    // "4 panes · acme, Acme live, 2 terminals"
    const all = leaves(r.layout.tree);
    const terms = terminalPanes(r.layout);
    const files = all.filter((id) => !terms.includes(id)).map((id) => {
      const p = r.layout.panes[id];
      return p?.loc ? where(p.loc, p.conn) : "empty";
    });
    const summary = `${all.length === 1 ? "1 pane" : `${all.length} panes`} · ${[...files, ...(terms.length ? [terms.length === 1 ? "terminal" : `${terms.length} terminals`] : [])].join(", ")}`;
    return {
      summary,
      terminals: terminalPanes(r.layout).map((id) => ({ id, label: label(id), startup: (r.layout.panes[id]?.startup ?? []).join("\n") })),
      openOnLaunch: w.start === "saved",
      matches: matchesRecipe(h.layoutOf(wsId), r.layout),
    };
  };

  /** "+": with recipes saved, a menu of an empty workspace and each recipe; else an empty workspace. */
  const newMenu = (anchor?: DOMRect) => {
    const h = host.current;
    if (!h) return;
    if (!anchor) return h.newEmpty();
    h.menu(anchor.left, anchor.bottom + 4, [
      { type: "item", label: "Empty workspace", icon: "plus", hint: "⌘T", onClick: h.newEmpty },
      { type: "item", label: "Copy of this workspace", icon: "copy", onClick: h.duplicate },
      ...(recipes.length
        ? [
            { type: "sep" as const },
            { type: "label" as const, label: "From a recipe" },
            ...recipes.map((r) => ({ type: "item" as const, label: r.name, icon: "columns" as const, onClick: () => openNew(r) })),
          ]
        : []),
    ]);
  };

  // ⌘K: each recipe, and the workspace on screen's own
  const latest = useRef({ recipes, openNew, reset, save, recipeOf });
  latest.current = { recipes, openNew, reset, save, recipeOf };
  useEffect(
    () =>
      registerCommands("recipes", () => {
        const { recipes: list, openNew: open, reset: back, save: keep, recipeOf: of } = latest.current;
        const h = host.current;
        const now = h?.ws.list.find((w) => w.id === h.ws.active);
        const mine = of(now);
        return [
          ...list.map((r) => ({
            id: `recipe:open:${r.id}`,
            title: `Open Workspace Recipe “${r.name}”`,
            group: "Workspaces",
            icon: "columns" as const,
            keywords: "recipe template layout startup",
            run: () => open(r),
          })),
          {
            id: "recipe:reset",
            title: "Reset Workspace to Recipe",
            group: "Workspaces",
            icon: "refresh" as const,
            keywords: "recipe restore layout",
            disabled: mine ? null : "This workspace has no recipe. Save one in its settings first",
            run: () => void (now && back(now.id)),
          },
          {
            id: "recipe:save",
            title: mine ? "Update Workspace Recipe from Layout" : "Save Layout as Workspace Recipe",
            group: "Workspaces",
            icon: "columns" as const,
            keywords: "recipe template layout startup",
            disabled: mine && now && h && matchesRecipe(h.layoutOf(now.id), mine.layout) ? "The recipe already matches this layout" : null,
            run: () => void (now && keep(now.id)),
          },
        ];
      }),
    [],
  );

  return {
    recipes,
    host,
    notes,
    clearNotes: () => setNotes((cur) => (Object.keys(cur).length ? {} : cur)),
    clearNote: (id: PaneId) => setNotes((cur) => (cur[id] ? { ...cur, [id]: undefined } : cur)),
    recipeOf,
    atLaunch,
    missingAtLaunch,
    save,
    reset,
    openNew,
    remove,
    setLines,
    renamed,
    view,
    newMenu,
  };
}
