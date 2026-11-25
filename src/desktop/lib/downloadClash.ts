/**
 * Name clashes for downloads. The backend never loses a file by itself: when the local name is
 * taken it writes "photo (1).jpg" instead. That was silent, so downloading a folder twice left a
 * second copy of everything. This asks first, with the same dialog as uploads and moves:
 * Replace, Keep both or Skip, "Skip all" / "Replace all" and "Remember until Kybl quits".
 *
 * A folder download finds its files while it is still listing, so clashes arrive in batches. The
 * gate checks each batch against the disk in one call and asks once per batch; while a question
 * is open the batches that come meanwhile wait and are asked together. "All" holds for the rest
 * of the download, files found later included, so a 2,000-file folder asks at most once.
 */
import type { Choice, Clash, Sticky } from "./conflicts";
import type { ResolveOpts } from "../../transfers/components/ConflictDialog";

/** What the gate needs of a download: its name under the picked folder, and where it will be written. */
type Item = { name: string; local: string; overwrite?: boolean };
/** Which of these local paths already have a file (`findExistingLocal`; passed in so this file stays free of the backend). */
type Exists = (paths: string[]) => Promise<Set<string>>;
type Ask = (clashes: Clash[], verb: string, where: string, opts?: ResolveOpts) => Promise<Map<string, Choice> | null>;

export function downloadClashGate<T extends Item>(o: {
  ask: Ask;
  exists: Exists;
  /** the folder the files go to, as the dialog names it */
  where: string;
  /** gets the files that may download: skipped ones left out, replaced ones marked `overwrite` */
  start: (items: T[]) => void;
  /** the dialog was closed: the rest of the download is off */
  onCancel?: () => void;
}) {
  const sticky: Sticky = {};
  let pending: T[] = [];
  let running: Promise<void> | null = null;
  let listing = true;
  const state = { cancelled: false, skipped: 0 };

  const drain = async () => {
    try {
      while (pending.length && !state.cancelled) {
        const batch = pending;
        pending = [];
        let there: Set<string>;
        try {
          there = await o.exists(batch.map((i) => i.local));
        } catch {
          // couldn't look: the backend still gives a clashing file a free name, so nothing is lost
          there = new Set();
        }
        const seen = new Set<string>();
        const clashes: Clash[] = [];
        for (const i of batch) {
          if (there.has(i.local) && !seen.has(i.local)) {
            seen.add(i.local);
            clashes.push({ key: i.local, name: i.name, folder: false });
          }
        }
        let choices = new Map<string, Choice>();
        if (clashes.length) {
          const r = await o.ask(clashes, "Downloading", o.where, { sticky, more: listing, remember: "download" });
          if (!r) {
            state.cancelled = true;
            pending = [];
            o.onCancel?.();
            return;
          }
          choices = r;
        }
        const go: T[] = [];
        for (const i of batch) {
          const c = choices.get(i.local);
          if (c === "skip") state.skipped++;
          else go.push(c === "replace" ? { ...i, overwrite: true } : i);
        }
        if (go.length) o.start(go);
      }
    } catch (e) {
      // the dialog or the transfer store failed: stop the listing with the failure rather than
      // dropping this batch and carrying on with the next
      state.cancelled = true;
      pending = [];
      o.onCancel?.();
      throw e;
    } finally {
      running = null;
    }
  };

  return {
    /** Files found: starts those with no clash (or whose clash was answered) as soon as it can. */
    add(items: T[]) {
      if (!items.length || state.cancelled) return;
      pending.push(...items);
      running ??= drain();
    },
    /** No more files are coming: "all" then covers only what is already here. */
    end() {
      listing = false;
    },
    /** Resolves once everything added has been asked about and started. */
    async settled() {
      while (running) await running;
    },
    get cancelled() {
      return state.cancelled;
    },
    /** Files left out because the user chose Skip. */
    get skipped() {
      return state.skipped;
    },
  };
}

/** The one-shot form, for a download whose files are all known (a picked file, a phone's list). Null: cancelled. */
export async function resolveDownloadClashes<T extends Item>(items: T[], ask: Ask, exists: Exists, where: string): Promise<{ items: T[]; skipped: number } | null> {
  const out: T[] = [];
  const gate = downloadClashGate<T>({ ask, exists, where, start: (b) => out.push(...b) });
  gate.add(items);
  gate.end();
  await gate.settled();
  return gate.cancelled ? null : { items: out, skipped: gate.skipped };
}
