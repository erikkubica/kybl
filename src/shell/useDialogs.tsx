/**
 * The app's shared dialogs as a context, so a browser pane (or anything below the shell) can
 * ask a question without owning the dialog: confirm, prompt, context menus, toasts, the
 * name-clash prompt and any modal of its own (`show`). Only one of each is up at a time, and
 * `isOpen` tells the keyboard handling that something owns the keyboard.
 */
import { logMessage } from "../activityLog";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog, ContextMenu, PromptDialog, Toasts, type MenuItem, type Toast } from "../components/Dialogs";
import { useConflictPrompt } from "../components/ConflictDialog";
import type { ToastAction } from "../desktop/fileOps";
import type { Choice, Clash } from "../desktop/conflicts";

export type ConfirmOptions = { title: string; message: ReactNode; label: string; danger?: boolean };
export type PromptOptions = { title: string; label: string; initial: string; confirmLabel: string; note?: string; run: (v: string) => void };

export type Dialogs = {
  /** resolves true when confirmed, false when cancelled */
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  prompt: (o: PromptOptions) => void;
  menu: (x: number, y: number, items: MenuItem[]) => void;
  toast: (kind: Toast["kind"], text: string, action?: ToastAction) => void;
  resolveConflicts: (clashes: Clash[], verb: string, where: string) => Promise<Map<string, Choice> | null>;
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

type ConfirmState = ConfirmOptions & { resolve: (ok: boolean) => void };
let modalSeq = 0;

export function DialogsProvider({ children }: { children: ReactNode }) {
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [prompt, setPrompt] = useState<PromptOptions | null>(null);
  const [menu, setMenu] = useState<null | { x: number; y: number; items: MenuItem[] }>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modals, setModals] = useState<{ id: number; render: (close: () => void) => ReactNode }[]>([]);
  const conflicts = useConflictPrompt();

  const open = useRef(false);
  open.current = !!(confirm || prompt || menu || modals.length || conflicts.open);

  // each toast leaves by itself (see Toasts: longer for errors, held while hovered or focused)
  const toast = useCallback((kind: Toast["kind"], text: string, action?: ToastAction) => {
    const id = Date.now() + Math.random();
    logMessage(kind, text);
    setToasts((t) => [...t.slice(-3), { id, kind, text, action }]);
  }, []);
  const confirmAsync = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setConfirm({ ...o, resolve })), []);
  const showMenu = useCallback((x: number, y: number, items: MenuItem[]) => setMenu({ x, y, items }), []);
  const show = useCallback((render: (close: () => void) => ReactNode) => {
    const id = ++modalSeq;
    setModals((m) => [...m, { id, render }]);
  }, []);
  const isOpen = useCallback(() => open.current, []);

  const api = useMemo<Dialogs>(
    () => ({ confirm: confirmAsync, prompt: setPrompt, menu: showMenu, toast, resolveConflicts: conflicts.resolve, show, isOpen }),
    [confirmAsync, showMenu, toast, conflicts.resolve, show, isOpen],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.label}
          danger={!!confirm.danger}
          onConfirm={() => confirm.resolve(true)}
          onClose={() => {
            // after a confirm this is a no-op: the promise already settled
            confirm.resolve(false);
            setConfirm(null);
          }}
        />
      )}
      {prompt && (
        <PromptDialog
          title={prompt.title}
          label={prompt.label}
          initial={prompt.initial}
          confirmLabel={prompt.confirmLabel}
          note={prompt.note}
          onSubmit={prompt.run}
          onClose={() => setPrompt(null)}
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
