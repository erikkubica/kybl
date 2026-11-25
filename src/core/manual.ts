/**
 * The user manual on the website (website/manual/index.html), and the app's other help links.
 * A topic is one of the manual's section ids, so a "?" next to a feature opens the page there.
 */
import { openLink } from "./openLink";

export const MANUAL_URL = "https://kybl.app/manual/";
export const FEATURES_URL = "https://kybl.app/features/";
export const RELEASES_URL = "https://github.com/erikkubica/kybl/releases";
export const ISSUES_URL = "https://github.com/erikkubica/kybl/issues/new";

/** The manual's sections (h2 ids) and the sub-sections the app links to (h3 ids). */
export type ManualTopic =
  | "getting-started"
  | "connections"
  | "kybl-storage"
  | "browsing"
  | "selecting"
  | "preview"
  | "editing"
  | "file-operations"
  | "drag-and-drop"
  | "copy-move"
  | "panes"
  | "workspaces"
  | "terminal"
  | "archives"
  | "compare"
  | "transfers"
  | "sharing"
  | "sync"
  | "keep-and-sync"
  | "mirror"
  | "actions"
  | "command-palette"
  | "settings"
  | "drives"
  | "what-works-where"
  | "phone"
  | "updates"
  | "shortcuts"
  | "troubleshooting"
  | "privacy"
  // sub-sections
  | "rename"
  | "conflicts"
  | "recipes"
  | "ssh-tunnels"
  | "import"
  | "settings-general"
  | "settings-appearance"
  | "settings-browsing"
  | "settings-transfers"
  | "settings-actions"
  | "settings-sync"
  | "settings-drives"
  | "settings-connections"
  | "settings-cache"
  | "settings-shortcuts";

export const manualUrl = (topic?: ManualTopic): string => (topic ? `${MANUAL_URL}#${topic}` : MANUAL_URL);

/** Opens the manual (at `topic`) in the browser; a failure to open says nothing (there's no page to show it on). */
export function openManual(topic?: ManualTopic): void {
  void openLink(manualUrl(topic)).catch(() => {});
}

export function openHelpLink(url: string): void {
  void openLink(url).catch(() => {});
}
