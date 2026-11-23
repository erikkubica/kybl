/**
 * Opening a file that came from a connection (not this computer) in another app: a download, an
 * edit copy, a synced file, a sync conflict copy. Every such opener goes through here, so a
 * program, script or installer is asked about first wherever it is opened from.
 */
import { api } from "../api";
import type { ConfirmOptions } from "../shell/useDialogs";
import { runsCode } from "./runnable";

export type Confirm = (o: ConfirmOptions) => Promise<boolean>;

/** The app to open in: undefined = the default app, null = Windows' "Choose an app", else an app's path. */
export type OpenApp = string | null | undefined;

/**
 * A file from a connection that runs as a program when it opens is asked about first (a click
 * on a file usually means "show me", not "run it"). True when it may open.
 */
export async function okToRun(name: string, confirm: Confirm): Promise<boolean> {
  if (!runsCode(name)) return true;
  return confirm({
    title: `Run “${name}”?`,
    message: (
      <>
        <p>This kind of file runs as a program when it opens, with access to this computer.</p>
        <p className="hint">Open it only if you trust where it came from.</p>
      </>
    ),
    label: "Open anyway",
    danger: true,
  });
}

/** Opens `path` in `app`, without asking (the caller asked, or the file is this computer's own). */
export function openIn(path: string, app: OpenApp): Promise<void> {
  return app === undefined ? api.openLocal(path) : app === null ? api.openWithChooser(path) : api.openWith(path, app);
}

/**
 * Opens `path`, a file that came from a connection, asking first when it runs code. False when
 * the person said no; errors are thrown.
 */
export async function openFromConnection(path: string, confirm: Confirm, app: OpenApp = undefined, name = baseName(path)): Promise<boolean> {
  if (!(await okToRun(name, confirm))) return false;
  await openIn(path, app);
  return true;
}

const baseName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
