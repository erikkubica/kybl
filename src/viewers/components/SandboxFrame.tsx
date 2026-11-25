/**
 * The only place untrusted HTML (rendered Markdown, converted Word documents) is ever shown.
 *
 * Why an iframe and not a shadow root or the page itself: the app runs with `csp: null` and every
 * page can call the Rust backend. A shadow root is not a security boundary, so one script that
 * slipped through (an `<svg onload>`, a `javascript:` link someone clicks) would run with full
 * access to every connection. A sandboxed iframe without `allow-scripts` runs no script at all,
 * whatever the HTML contains; the HTML is also cleaned with DOMPurify before it gets here, and a
 * CSP inside the frame blocks loading anything from the network except, where allowed, images.
 *
 * `allow-same-origin` (without `allow-scripts`) lets this component reach into the frame to make
 * links open in the browser instead of inside the frame, and to scale wide pages to fit. With no
 * script running inside the frame, sharing the origin gives the content nothing it could use.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { watchMenuKeysIn } from "../../desktop/lib/menuKeyWatch";
import { openLink } from "../../core/openLink";

type Theme = Record<"bg" | "text" | "dim" | "border" | "accent" | "panel" | "font" | "mono" | "code", string>;

function readTheme(): Theme {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string, d: string) => s.getPropertyValue(n).trim() || d;
  return {
    bg: v("--bg", "#fff"),
    text: v("--text", "#17181c"),
    dim: v("--dim", "#60636e"),
    border: v("--border", "#e6e6eb"),
    accent: v("--accent", "#2c6bf2"),
    panel: v("--panel", "#f7f7f9"),
    font: v("--font", "sans-serif"),
    mono: v("--mono", "monospace"),
    code: v("--hover", "rgba(0,0,0,.05)"),
  };
}

/** Follows the app's light/dark switch (the `data-theme` attribute on <html>). */
export function useAppTheme(): Theme {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(readTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent"] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

const esc = (s: string) => s.replace(/[<>"]/g, "");

export function SandboxFrame({
  html,
  css,
  title,
  remoteImages,
  fitWidth,
  className,
}: {
  /** body HTML, already sanitized */
  html: string;
  /** extra styles; may use the theme values through `var(--x)`: bg, text, dim, border, accent, panel, code */
  css?: string;
  title: string;
  /** allow https images (Markdown badges and screenshots); off for Word documents */
  remoteImages?: boolean;
  /** pages this wide (px) are scaled down to fit a narrower frame (Word pages on phones) */
  fitWidth?: number;
  className?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const theme = useAppTheme();

  const latest = useRef(html);
  latest.current = html;

  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; img-src data: blob:${remoteImages ? " https:" : ""}`;
  // The page shell only changes with the theme; new HTML goes straight into the body (below), so
  // the live Markdown preview keeps its scroll position while typing.
  const doc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<style>:root{--bg:${esc(theme.bg)};--text:${esc(theme.text)};--dim:${esc(theme.dim)};--border:${esc(theme.border)};` +
      `--accent:${esc(theme.accent)};--panel:${esc(theme.panel)};--code:${esc(theme.code)};--font:${esc(theme.font)};--mono:${esc(theme.mono)}}` +
      `html{background:var(--bg);color:var(--text);font-family:var(--font);-webkit-text-size-adjust:100%}` +
      `body{margin:0}a{color:var(--accent)}` +
      `${css ?? ""}</style></head><body>${latest.current}</body></html>`,
    [theme, css, csp],
  );
  const shown = useRef(html);
  useEffect(() => {
    const body = frame.current?.contentDocument?.body;
    if (!body || shown.current === html) return;
    // parsed in the frame's own (sandboxed) document, so nothing in it runs
    body.innerHTML = html;
    shown.current = html;
  }, [html]);

  // links: in-page anchors scroll, web and mail links open in the browser, the rest do nothing
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const onClick = (ev: MouseEvent) => {
      // an image map's <area href> is a link too (sanitizers drop maps, but the frame must never
      // follow one itself: nothing but this handler decides where a click goes)
      const a = (ev.target as Element | null)?.closest?.("a, area");
      if (!a) return;
      ev.preventDefault();
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) {
        let id = href.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {
          // a stray "%" in the anchor: look the raw id up instead
        }
        const d = el.contentDocument;
        // Markdown's ids carry GitHub's "user-content-" prefix (see renderMarkdown)
        const find = (n: string) => d?.getElementById(n) ?? d?.getElementsByName(n)[0];
        (find(id) ?? find(`user-content-${id}`))?.scrollIntoView({ block: "start" });
        return;
      }
      // opened as parsed (see openLink), never the raw attribute text
      void openLink(href).catch(() => {});
    };
    const fit = () => {
      const d = el.contentDocument;
      if (!d?.body || !fitWidth) return;
      const scale = Math.min(1, (el.clientWidth - 8) / fitWidth);
      d.body.style.setProperty("zoom", scale < 1 ? String(scale) : "");
    };
    // Keys pressed while the frame has focus fire in the frame's own document and never reach the
    // app's window listeners (Quick Look's Esc/Space/arrows, the editor's Esc/⌘S/⌘W). Hand each one
    // on as a copy dispatched on the <iframe> element, so it bubbles through the app like any other
    // key; if an app handler claims it, the frame does not act on it too (Space would scroll).
    const onKey = (ev: KeyboardEvent) => {
      // ⌘A is always the frame's own (select the page); ⌘C is while text is selected in it
      const k = ev.key.toLowerCase();
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && k === "a" && !ev.shiftKey && !ev.altKey) return;
      if (mod && k === "c" && el.contentWindow?.getSelection()?.toString()) return;
      const copy = new KeyboardEvent(ev.type, {
        key: ev.key,
        code: ev.code,
        location: ev.location,
        repeat: ev.repeat,
        ctrlKey: ev.ctrlKey,
        shiftKey: ev.shiftKey,
        altKey: ev.altKey,
        metaKey: ev.metaKey,
        bubbles: true,
        cancelable: true,
      });
      if (!el.dispatchEvent(copy)) ev.preventDefault();
    };
    // ⌘ pressed in the frame never reaches the app's window: watched here too, so a menu
    // accelerator taken by macOS while the preview has focus goes back to it as the key and
    // doesn't run the command behind it (menuKeyWatch.ts)
    let unwatch: (() => void) | null = null;
    const onLoad = () => {
      shown.current = latest.current;
      el.contentDocument?.addEventListener("click", onClick);
      el.contentDocument?.addEventListener("keydown", onKey);
      unwatch?.();
      unwatch = el.contentWindow ? watchMenuKeysIn(el.contentWindow) : null;
      fit();
    };
    el.addEventListener("load", onLoad);
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => {
      el.removeEventListener("load", onLoad);
      el.contentDocument?.removeEventListener("click", onClick);
      el.contentDocument?.removeEventListener("keydown", onKey);
      unwatch?.();
      ro.disconnect();
    };
  }, [fitWidth]);

  return <iframe ref={frame} className={`dv-frame ${className ?? ""}`} title={title} sandbox="allow-same-origin" srcDoc={doc} />;
}
