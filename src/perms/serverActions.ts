/**
 * What a pane offers for permissions and links on a server: "Show original" for a link,
 * "Permissions…" for a selection, "Make link…" for one item. Only where the connection has them
 * (`caps.permissions`, `caps.links`); S3 and the cloud drives never show these.
 */
import { createElement } from "react";
import { errMessage } from "../api";
import { parentPrefix } from "../format";
import { entryParent } from "../moving";
import type { MenuItem } from "../components/Dialogs";
import type { Entry } from "../types";
import type { PaneCore, PaneEnv } from "../browser/usePane";
import { PermissionsSheet } from "./PermissionsSheet";
import { permsApi } from "./permsApi";

export function serverActions(pane: PaneCore, env: PaneEnv) {
  const { profile, bucket, caps } = pane;
  const { toast } = env.dialogs;
  const canChmod = !!caps?.permissions;
  const canLink = !!caps?.links;

  const askPermissions = (list: Entry[]) => {
    if (!profile || bucket == null || !list.length || !canChmod) return;
    const [pid, b] = [profile.id, bucket];
    env.dialogs.show((close) =>
      createElement(PermissionsSheet, {
        profileId: pid,
        bucket: b,
        items: list,
        onDone: (n: number) => {
          pane.ent.refresh();
          toast("success", n === 1 ? "Permissions changed" : `Permissions changed on ${n.toLocaleString()} items`);
        },
        onClose: close,
      }),
    );
  };

  /** Like Finder's Show Original: the folder the link points into, with the original selected. */
  const showOriginal = async (e: Entry) => {
    if (!profile || bucket == null) return;
    try {
      const to = await permsApi.resolveLink(profile.id, bucket, e.key);
      if (!to.key) pane.navigate("");
      else pane.navigate(parentPrefix(to.key), to.key);
    } catch (err) {
      toast("error", errMessage(err));
    }
  };

  /** A link next to the item, pointing at it by name ("report link.pdf", keeping the file's type). */
  const askMakeLink = (e: Entry) => {
    if (!profile || bucket == null) return;
    const [pid, b] = [profile.id, bucket];
    const dir = entryParent(e);
    const dot = e.kind === "file" ? e.name.lastIndexOf(".") : -1;
    env.dialogs.prompt({
      title: "Make link",
      label: `A link to “${e.name}”, in the same folder`,
      initial: dot > 0 ? `${e.name.slice(0, dot)} link${e.name.slice(dot)}` : `${e.name} link`,
      confirmLabel: "Make link",
      run: (name) => {
        const n = name.trim().replace(/\/+$/, "");
        if (!n || n.includes("/")) return toast("error", "A link's name can't be empty or contain “/”.");
        permsApi
          .makeLink(pid, b, dir + n, e.name)
          .then(() => {
            pane.ent.refresh();
            toast("success", `Made “${n}”`);
          })
          .catch((err) => toast("error", errMessage(err)));
      },
    });
  };

  /** The context menu's part: placed after Get Info. */
  const itemsFor = (list: Entry[], e: Entry): (MenuItem | false)[] => {
    const one = list.length === 1;
    return [
      one && canLink && e.link !== undefined && { type: "item", label: "Show original", icon: "reveal", onClick: () => void showOriginal(e) },
      canChmod && { type: "item", label: one ? "Permissions…" : `Permissions of ${list.length} items…`, icon: "settings", onClick: () => askPermissions(list) },
      one && canLink && { type: "item", label: "Make link…", icon: "link", onClick: () => askMakeLink(e) },
    ];
  };

  return { itemsFor, askPermissions: canChmod ? askPermissions : undefined, showOriginal: canLink ? showOriginal : undefined };
}
