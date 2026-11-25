/**
 * A connection's own photo settings, in its right-click menu: which image mode its lists use
 * (or the app's), and whether it shares placeholders through a hidden file in each photo folder.
 */
import type { MenuItem } from "../../ui/components/Dialogs";
import { peekCaps } from "../../core/useCaps";
import { LOCAL_ID } from "../../core/api";
import { IMAGE_MODES, SHARE_PLACEHOLDERS_TEXT, appImageMode, connImageMode, imageModeLabel, setConnImageMode, setSharedPlaceholders, sharedPlaceholdersOn } from "../../thumbs/imageMode";
import type { Profile } from "../../core/types";
import type { Dialogs } from "../hooks/useDialogs";

export function photoMenuItems(p: Profile, dialogs: Pick<Dialogs, "confirm">): MenuItem[] {
  const own = connImageMode(p.id);
  // this computer's own files are never shared
  const local = p.id === LOCAL_ID || p.kind === "local" || !!peekCaps(p.id)?.localPaths;
  const shared = sharedPlaceholdersOn(p.id);
  const share = async () => {
    if (shared) return setSharedPlaceholders(p.id, false);
    const ok = await dialogs.confirm({
      title: `Share photo placeholders on “${p.name}”?`,
      label: "Share placeholders",
      message: <p>{SHARE_PLACEHOLDERS_TEXT}</p>,
    });
    if (ok) setSharedPlaceholders(p.id, true);
  };
  return [
    { type: "sep" },
    { type: "label", label: "Photos in lists" },
    { type: "item", label: `As in Settings (${imageModeLabel(appImageMode())})`, checked: own === null, onClick: () => setConnImageMode(p.id, null) },
    ...IMAGE_MODES.map((m): MenuItem => ({ type: "item", label: m.label, checked: own === m.id, onClick: () => setConnImageMode(p.id, m.id) })),
    ...(local ? [] : [{ type: "item" as const, label: "Share placeholders with other devices", checked: shared, onClick: () => void share() }]),
  ];
}
