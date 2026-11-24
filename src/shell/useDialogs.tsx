/**
 * The app's shared dialogs as a context, so a browser pane (or anything below the shell) can
 * ask a question without owning the dialog: confirm, prompt, context menus, toasts, the
 * name-clash prompt and any modal of its own (`show`). Only one of each is up at a time, and
 * `isOpen` tells the keyboard handling that something owns the keyboard.
 */
import { logMessage } from "../activityLog";
import { addNotification, answersUser, dragging, inBackgroundNow } from "./notifications";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog, ContextMenu, PromptDialog, Toasts, type MenuItem, type PromptResult, type Toast } from "../components/Dialogs";
import { useConflictPrompt, type ResolveOpts } from "../components/ConflictDialog";
import type { ToastAction } from "../desktop/fileOps";
import type { Choice, Clash } from "../desktop/conflicts";
import type { IconName } from "../Icons";

/** `danger`: red button, focus starts on Cancel; `icon`: the title's icon (a danger confirm shows the trash unless given). */
export type ConfirmOptions = { title: string; message: ReactNode; label: string; cancelLabel?: string; danger?: boolean; icon?: IconName };
/**
 * `check`: what is wrong with a name, at once (the dialog stays open, the message under the field);
 * `run`: a string back, also from its promise, is what went wrong there (the server refused, say): the
 * dialog stays open with the name as typed. Long work is started, not awaited, once the name is fine.
 */
export type PromptOptions = {
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  note?: string;
  /** select the whole name, not only the part before the last dot (a folder has no extension) */
  selectAll?: boolean;
  check?: (v: string) => string | null;
  run: (v: string) => PromptResult | Promise<PromptResult>;
};

export type Dialogs = {
  /** resolves true when confirmed, false when cancelled */
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  prompt: (o: PromptOptions) => void;
  menu: (x: number, y: number, items: MenuItem[]) => void;
  toast: (kind: Toast["kind"], text: string, action?: ToastAction) => void;
  resolveConflicts: (clashes: Clash[], verb: string, where: string, opts?: ResolveOpts) => Promise<Map<string, Choice> | null>;
  /** shows a modal of the caller's own; `render` gets the function that closes it */
  show: (render: (close: () => void) => ReactNode) => void;
  /** a dialog or menu from here is up */
  isOpen: () => boolean;
};

const Ctx = createContext<Dialogs | null>(null);

export function useDialogs(): Dialogs {
  const d = useContext(Ctx);
  if (!d) throw new Error("useDialogs needs a DialogsProvider");
  return d;
}

/** `seq`: each question its own dialog, so a newer one remounts and focuses afresh (Cancel first when danger) */
type ConfirmState = ConfirmOptions & { resolve: (ok: boolean) => void; seq: number };
let modalSeq = 0;

export function DialogsProvider({ children }: { children: ReactNode }) {
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [prompt, setPrompt] = useState<(PromptOptions & { seq: number }) | null>(null);
  const showPrompt = useCallback((o: PromptOptions) => setPrompt({ ...o, seq: ++modalSeq }), []);
  const [menu, setMenu] = useState<null | { x: number; y: number; items: MenuItem[] }>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modals, setModals] = useState<{ id: number; render: (close: () => void) => ReactNode }[]>([]);
  // each toast leaves by itself (see Toasts: longer for errors, held while hovered or focused)
  // Every toast goes into the bell's list. It pops up when it answers the user (input just before
  // it), and an error always does (a rename that failed after a slow server took its time) unless
  // it comes from background work; nothing pops up over a drag. The rest waits in the bell as
  // unread, so background work never lands over what is being done.
  const open = useRef(false);
  const toast = useCallback((kind: Toast["kind"], text: string, action?: ToastAction) => {
    logMessage(kind, text);
    const popUp = (answersUser() || (kind === "error" && !inBackgroundNow())) && !dragging();
    addNotification(kind, text, action, popUp);
    if (!popUp) return;
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text, action }]);
  }, []);
  const conflicts = useConflictPrompt(toast);
  open.current = !!(confirm || prompt || menu || modals.length || conflicts.open);
  // one confirm at a time: a newer question cancels an older one still up (its promise says false)
  const current = useRef<ConfirmState | null>(null);
  const confirmAsync = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        current.current?.resolve(false);
        const next = { ...o, resolve, seq: ++modalSeq };
        current.current = next;
        setConfirm(next);
      }),
    [],
  );
  const showMenu = useCallback((x: number, y: number, items: MenuItem[]) => setMenu({ x, y, items }), []);
  const show = useCallback((render: (close: () => void) => ReactNode) => {
    const id = ++modalSeq;
    setModals((m) => [...m, { id, render }]);
  }, []);
  const isOpen = useCallback(() => open.current, []);

  const api = useMemo<Dialogs>(
    () => ({ confirm: confirmAsync, prompt: showPrompt, menu: showMenu, toast, resolveConflicts: conflicts.resolve, show, isOpen }),
    [confirmAsync, showPrompt, showMenu, toast, conflicts.resolve, show, isOpen],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      {confirm && (
        <ConfirmDialog
          key={confirm.seq}
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.label}
          cancelLabel={confirm.cancelLabel}
          danger={!!confirm.danger}
          icon={confirm.icon}
          onConfirm={() => confirm.resolve(true)}
          onClose={() => {
            // after a confirm this is a no-op: the promise already settled
            confirm.resolve(false);
            if (current.current === confirm) current.current = null;
            setConfirm((c) => (c === confirm ? null : c));
          }}
        />
      )}
      {prompt && (
        <PromptDialog
          key={prompt.seq}
          title={prompt.title}
          label={prompt.label}
          initial={prompt.initial}
          confirmLabel={prompt.confirmLabel}
          note={prompt.note}
          selectAll={prompt.selectAll}
          check={prompt.check}
          onSubmit={prompt.run}
          onClose={() => setPrompt((p) => (p?.seq === prompt.seq ? null : p))}
          onLostError={(why) => toast("error", why)}
        />
      )}
      {modals.map((m) => (
        <ModalSlot key={m.id} render={m.render} close={() => setModals((list) => list.filter((x) => x.id !== m.id))} />
      ))}
      {conflicts.element}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      <Toasts toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </Ctx.Provider>
  );
}

function ModalSlot({ render, close }: { render: (close: () => void) => ReactNode; close: () => void }) {
  return <>{render(close)}</>;
}
