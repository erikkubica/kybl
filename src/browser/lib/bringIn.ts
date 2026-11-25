import type { MenuItem } from "../../ui/components/Dialogs";

/**
 * Bringing files in: uploads on a connection; on this computer, copies and moves into the folder
 * (the + menu and the empty space's menu).
 */
export function bringInItems(onDisk: boolean, ops: { pickAndUpload: (dir: boolean) => unknown; pickAndMove: (dir: boolean) => unknown }): MenuItem[] {
  if (!onDisk)
    return [
      { type: "item", label: "Upload files…", icon: "upload", hint: "⌘U", onClick: () => void ops.pickAndUpload(false) },
      { type: "item", label: "Upload folder…", icon: "folder", hint: "⇧⌘U", onClick: () => void ops.pickAndUpload(true) },
    ];
  return [
    { type: "item", label: "Copy files here…", icon: "copy", hint: "⌘U", onClick: () => void ops.pickAndUpload(false) },
    { type: "item", label: "Copy folders here…", icon: "folder", hint: "⇧⌘U", onClick: () => void ops.pickAndUpload(true) },
    { type: "item", label: "Move files here…", icon: "move", onClick: () => void ops.pickAndMove(false) },
    { type: "item", label: "Move folders here…", icon: "move", onClick: () => void ops.pickAndMove(true) },
  ];
}
