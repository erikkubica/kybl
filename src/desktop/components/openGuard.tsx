/**
 * Opening a file that came from a connection (not this computer) in another app: a download, an
 * edit copy, a synced file, a sync conflict copy. Every such opener goes through here
 * (`openFromConnection`, after `okToRun` when the copy is fetched first), so a program, script or
 * installer is asked about wherever it is opened from. Only files of this computer's own disk use
 * `openOwnFile`.
 */
import { api } from "../../core/api";
import type { ConfirmOptions } from "../../shell/hooks/useDialogs";
import { appsFor } from "../lib/appsFor";
import { asksFirst, openerOf, type Opener } from "../lib/runnable";

export type Confirm = (o: ConfirmOptions) => Promise<boolean>;

/** The app to open in: undefined = the default app, null = Windows' "Choose an app", else an app's path. */
export type OpenApp = string | null | undefined;

/** Who opens a file called `name` in `app` (see `Opener`); an app list that fails counts as the default. */
async function openerFor(name: string, app: OpenApp): Promise<Opener> {
  if (app == null || app === "") return "default";
  let isDefault = true;
  try {
    const apps = await appsFor(name, false);
    isDefault = apps.some((a) => a.isDefault && a.path === app);
  } catch {
    // unknown: asked, as for the default app
  }
  return openerOf(app, isDefault);
}

/** The names among `names` that are asked about before they open in `app`. */
async function riskyOf(names: string[], app: OpenApp): Promise<string[]> {
  const out: string[] = [];
  for (const n of new Set(names)) if (asksFirst(n, await openerFor(n, app))) out.push(n);
  return out;
}

/**
 * Files from a connection that run as a program when they open in `app` are asked about first,
 * all in one question (a click on a file usually means "show me", not "run it"). True when they
 * may open; the person's answer covers every file in `names`.
 */
export async function okToRun(names: string[], confirm: Confirm, app: OpenApp = undefined): Promise<boolean> {
  return ask(await riskyOf(names, app), confirm);
}

function ask(risky: string[], confirm: Confirm): Promise<boolean> {
  if (!risky.length) return Promise.resolve(true);
  const one = risky.length === 1;
  const shown = risky.slice(0, 5);
  return confirm({
    title: one ? `Run “${risky[0]}”?` : `Run ${risky.length} programs?`,
    message: (
      <>
        <p>{one ? "This kind of file runs as a program when it opens, with access to this computer." : "These files run as programs when they open, with access to this computer."}</p>
        {!one && (
          <ul className="confirm-list">
            {shown.map((n) => (
              <li key={n}>{n}</li>
            ))}
            {risky.length > shown.length && <li>and {risky.length - shown.length} more</li>}
          </ul>
        )}
        <p className="hint">Open {one ? "it" : "them"} only if you trust where {one ? "it" : "they"} came from.</p>
      </>
    ),
    label: one ? "Open anyway" : "Open all",
    danger: true,
    icon: "alert",
  });
}

/** Opens `path`, a file of this computer's own disk, in `app`, without asking. */
export function openOwnFile(path: string, app: OpenApp): Promise<void> {
  return app === undefined ? api.openLocal(path) : app === null ? api.openWithChooser(path) : api.openWith(path, app);
}

/**
 * Opens `path`, a file that came from a connection (`name` there), in `app`, asking first when it
 * runs code. The name of the file on disk is checked too: it can differ from the remote one.
 * `asked`: `okToRun` already said yes for `name` (then only a different verdict for the file on
 * disk asks again). False when the person said no; errors are thrown.
 */
export async function openFromConnection(path: string, confirm: Confirm, app: OpenApp = undefined, name = baseName(path), asked = false): Promise<boolean> {
  const leaf = baseName(path);
  const byName = (await riskyOf([name], app)).length > 0;
  const byLeaf = leaf !== name && (await riskyOf([leaf], app)).length > 0;
  // one question, under the name the person knows; after `asked`, only when the copy on disk differs
  const askNow = asked ? byLeaf && !byName : byName || byLeaf;
  if (askNow && !(await ask([byName ? name : leaf], confirm))) return false;
  await openOwnFile(path, app);
  return true;
}

export const baseName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
