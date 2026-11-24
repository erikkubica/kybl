/**
 * Web and mail links to the default browser or mail app. Every link the app hands to the system
 * goes through here: the text is parsed as a URL first and only http, https and mailto pass, then
 * the parsed form is opened (`u.href`: spaces, quotes, angle brackets and control characters come
 * out percent-encoded), never the string as a document or server wrote it.
 */
import { openUrl } from "@tauri-apps/plugin-opener";

const SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** The link as it may be opened, or null when it isn't a web or mail link. */
export function safeLink(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href.trim());
  } catch {
    return null;
  }
  if (!SCHEMES.has(u.protocol)) return null;
  // a web link needs a host ("http://" alone names nothing)
  if (u.protocol !== "mailto:" && !u.hostname) return null;
  return u.href;
}

/** Opens a web or mail link outside the app; rejects when it isn't one or the system can't. */
export async function openLink(href: string): Promise<void> {
  const url = safeLink(href);
  if (!url) throw new Error("Not a web or mail link.");
  await openUrl(url);
}
