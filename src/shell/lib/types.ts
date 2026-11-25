import type { PickId } from "../../connections/lib/kinds";
import type { Profile } from "../../core/types";

/** The connection dialog: editing `profile`, or a new one (on `startKind`'s form, when given). */
export type ConnDialogAsk = { profile: Profile | null; reconnect?: boolean; startKind?: PickId; startTab?: "tunnels" };
