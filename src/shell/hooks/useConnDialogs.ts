import { useState, useCallback } from "react";
import { type ConnDialogAsk } from "../lib/types";
import { type Profile } from "../../core/types";
import { THIS_MAC } from "../../browser/types";
import { KYBL } from "../../connections/lib/kybl";

export interface UseConnDialogsDeps {

}

/** Which connection dialog is up: the editor for a connection, Kybl Storage's own, or Import. */
export function useConnDialogs() {
  const [connDialog, setConnDialogState] = useState<ConnDialogAsk | null>(null);
  const [kyblDialog, setKyblDialog] = useState<{ existing: Profile | null; reconnect?: boolean } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  /** Opens the editor for a connection: Kybl Storage connections have their own (no keys to edit). */
  const setConnDialog = useCallback((d: ConnDialogAsk | null) => {
    if (d?.profile?.id === THIS_MAC.id) return; // built in: nothing to edit
    if (d?.profile?.provider === KYBL) setKyblDialog({ existing: d.profile, reconnect: d.reconnect });
    else setConnDialogState(d);
  }, []);
  return { connDialog, kyblDialog, setKyblDialog, importOpen, setImportOpen, setConnDialog };
}
