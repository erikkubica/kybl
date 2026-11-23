/**
 * The edit UI that only matters once something is being edited, as its own chunk: the shell
 * mounts these only while there are sessions, so the first load doesn't carry them.
 */
import { lazy } from "react";

export const LazyEditingChip = lazy(() => import("./EditingList").then((m) => ({ default: m.EditingChip })));
export const LazyEditConflictHost = lazy(() => import("./EditConflict").then((m) => ({ default: m.EditConflictHost })));
