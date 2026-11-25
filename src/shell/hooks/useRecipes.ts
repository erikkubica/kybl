/**
 * Workspace recipes (recipes.ts) kept per device in localStorage, beside the workspaces. A first
 * launch with recipes makes one of each workspace's "Always at these folders" from before, linked
 * to it by id (workspaces.ts names it the same way), so nothing is lost.
 */
import { useEffect, useState } from "react";
import { LS } from "../../browser/types";
import { WS_COLORS, WS_KEY, legacyRecipeId, parseLayout } from "../lib/workspaces";
import type { Recipe } from "../lib/recipes";

const KEY = "s3b.workspaceRecipes";

function parseRecipe(v: unknown): Recipe | null {
  const x = v as Record<string, unknown> | null;
  if (!x || typeof x !== "object" || typeof x.id !== "string" || !x.id) return null;
  const layout = parseLayout(x.layout);
  if (!layout) return null;
  const name = typeof x.name === "string" && x.name.trim() ? x.name.trim().slice(0, 80) : "Recipe";
  const color = typeof x.color === "string" && WS_COLORS.some((c) => c.id === x.color) ? x.color : null;
  return { id: x.id, name, color, layout };
}

function load(): Recipe[] {
  const raw = LS.get(KEY);
  if (raw != null) {
    try {
      const v = JSON.parse(raw) as { list?: unknown };
      const seen = new Set<string>();
      return (Array.isArray(v.list) ? v.list : []).map(parseRecipe).filter((r): r is Recipe => !!r && !seen.has(r.id) && !!seen.add(r.id));
    } catch {
      return [];
    }
  }
  // before recipes: a workspace's saved folders become its recipe
  try {
    const v = JSON.parse(LS.get(WS_KEY) ?? "null") as { list?: unknown } | null;
    const list = Array.isArray(v?.list) ? (v.list as Record<string, unknown>[]) : [];
    return list.flatMap((w) => {
      const layout = w && typeof w.id === "string" ? parseLayout(w.saved) : null;
      return layout ? [parseRecipe({ id: legacyRecipeId(w.id as string), name: w.name, color: w.color, layout })!] : [];
    });
  } catch {
    return [];
  }
}

export function useRecipes() {
  const [recipes, setRecipes] = useState<Recipe[]>(load);
  useEffect(() => LS.set(KEY, JSON.stringify({ list: recipes })), [recipes]);
  return [recipes, setRecipes] as const;
}
