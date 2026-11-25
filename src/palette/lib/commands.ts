/**
 * The command palette's (⌘K) registry of commands. The app's own commands are built when the
 * palette opens (shellCommands.ts); features add theirs here, as a list or as a function asked
 * each time the palette opens (so titles and `disabled` can follow what is on screen):
 *
 *   const off = registerCommands("mirrors", () => listMirrors().map((m) => ({
 *     id: `mirror:${m.id}`, title: `Run mirror “${m.name}”`, group: "Deploy", run: () => runMirror(m.id, {}),
 *   })));
 *
 * Registering again under the same source replaces its commands; the returned function removes them.
 * This module stays tiny and free of UI: it is in the main bundle, the palette itself is not.
 */
import type { IconName } from "../../ui/components/Icons";

export type PaletteCommand = {
  /** unique across sources (prefix it with the source): recent picks are remembered by it */
  id: string;
  title: string;
  /** shown dim after the title ("Panes", "Workspaces", a feature's name) and matched too */
  group?: string;
  /** more words to find it by ("hidden dotfiles") */
  keywords?: string;
  /** the shortcut as shown ("⇧⌘N") */
  shortcut?: string;
  icon?: IconName;
  /** why it can't run now: listed greyed with the reason, and not run. Falsy: it can run */
  disabled?: string | false | null;
  /** left out of the palette altogether (it makes no sense here at all) */
  hidden?: boolean;
  /** runs once the palette has closed (the keyboard is back where it was) */
  run: () => void | Promise<unknown>;
};

type Source = readonly PaletteCommand[] | (() => readonly PaletteCommand[]);

const sources = new Map<string, Source>();

/** Adds (or replaces) a source's commands; returns a function that removes them. */
export function registerCommands(source: string, cmds: Source): () => void {
  sources.set(source, cmds);
  return () => {
    if (sources.get(source) === cmds) sources.delete(source);
  };
}

/** Every registered command as of now (a source that throws is skipped). */
export function registeredCommands(): PaletteCommand[] {
  const out: PaletteCommand[] = [];
  for (const [name, s] of sources) {
    try {
      for (const c of typeof s === "function" ? s() : s) if (!c.hidden) out.push(c);
    } catch (e) {
      console.warn(`command palette: commands from “${name}” failed`, e);
    }
  }
  return out;
}
