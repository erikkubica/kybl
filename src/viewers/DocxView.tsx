/**
 * Word documents, read-only, laid out like the pages they are (docx-preview).
 *
 * docx-preview builds the pages as DOM elements. They are never put into the app's own page:
 * they are serialized, cleaned with DOMPurify and shown in SandboxFrame, where no script can run
 * (see there for why not a shadow root). Images are inlined as data URLs so the sandboxed frame,
 * which may load nothing from elsewhere, can still show them.
 */
import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { parseAsync, renderDocument } from "docx-preview";
import { SandboxFrame } from "./SandboxFrame";
import { Note } from "./ui";
import type { ViewerProps } from "./types";

/** A Word page (8.5in) plus the gap around it, in CSS pixels. */
const PAGE_W = 816 + 40;

const CSS = `
body{background:var(--panel)}
.docx-wrapper{background:transparent!important;padding:20px 0!important}
.docx-wrapper>section.docx{box-shadow:0 2px 10px rgba(0,0,0,.18)!important;margin:0 auto 20px!important}
`;

export default function DocxView({ name, bytes }: ViewerProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const options = {
        className: "docx",
        inWrapper: true,
        breakPages: true,
        useBase64URL: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        renderComments: false,
        experimental: false,
        trimXmlDeclaration: true,
        ignoreLastRenderedPageBreak: true,
      };
      const doc = await parseAsync(new Blob([bytes as BlobPart]), options);
      const nodes = await renderDocument(doc, options);
      // the nodes were made by docx-preview but never attached to the page
      const holder = document.createElement("div");
      for (const n of nodes) holder.appendChild(n);
      const clean = DOMPurify.sanitize(holder.innerHTML, { FORCE_BODY: true, ADD_TAGS: ["style"] });
      if (live) setHtml(clean);
    })().catch((e) => live && setError(String((e as Error)?.message ?? e)));
    return () => {
      live = false;
    };
  }, [bytes]);

  if (error) return <Note icon="alert">This document couldn't be shown. It may be damaged or use features the preview doesn't support.</Note>;
  if (html === null) return <Note spinner>Laying out the pages…</Note>;
  return (
    <div className="dv-viewer dv-docx">
      <SandboxFrame title={name} html={html} css={CSS} fitWidth={PAGE_W} />
    </div>
  );
}
