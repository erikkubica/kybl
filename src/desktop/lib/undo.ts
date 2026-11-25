/**
 * Undo for moves, renames and copies. Each finished action that can be reversed safely leaves an
 * entry here: the toast's Undo button runs it, and ⌘Z runs the most recent one.
 */
export type UndoEntry = { label: string; run: () => Promise<void> };

const MAX = 20;
const stack: UndoEntry[] = [];
// undos run one after another: two quick ⌘Z must not move the same things at once
let queue: Promise<void> = Promise.resolve();

export const undoStack = {
  push(e: UndoEntry) {
    stack.push(e);
    if (stack.length > MAX) stack.shift();
  },
  /** Takes the most recent entry off the stack. */
  pop: (): UndoEntry | undefined => stack.pop(),
  /** Takes this entry off the stack (it was run from its toast); false when it was already used. */
  take(e: UndoEntry): boolean {
    const i = stack.indexOf(e);
    if (i < 0) return false;
    stack.splice(i, 1);
    return true;
  },
  /** Runs an entry once every undo started before it has finished. */
  runQueued(e: UndoEntry): Promise<void> {
    queue = queue.then(() => e.run()).catch(() => {});
    return queue;
  },
};
