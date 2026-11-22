import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { api, errMessage } from "../api";

/** Largest PDF previewed in the app; bigger ones can still be downloaded. */
export const MAX_PDF_BYTES = 60 * 1000 * 1000;

type PdfJs = typeof import("pdfjs-dist");
let engine: Promise<PdfJs> | null = null;

/** pdf.js is large, so it loads the first time a PDF is previewed. */
function loadEngine(): Promise<PdfJs> {
  engine ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  });
  return engine;
}

/**
 * A PDF drawn by the app itself instead of the system viewer in an iframe. The system viewer owns
 * its own right-click menu (zoom, "Open with…"), which can't be changed from the page; drawing the
 * pages ourselves keeps the preview consistent with the rest of the app.
 */
export function PdfView({ profileId, bucket, objectKey, onError }: { profileId: string; bucket: string; objectKey: string; onError: (msg: string) => void }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [width, setWidth] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    let opened: PDFDocumentProxy | null = null;
    (async () => {
      const [pdfjs, bytes] = await Promise.all([loadEngine(), api.objectBytes(profileId, bucket, objectKey, MAX_PDF_BYTES, true)]);
      const d = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
      if (!live) return void d.destroy();
      opened = d;
      setDoc(d);
    })().catch((e) => live && onError(errMessage(e) || "Could not open this PDF"));
    return () => {
      live = false;
      opened?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, bucket, objectKey]);

  // pages are drawn at the pane's width, so follow it while the pane is resized
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let timer = 0;
    const measure = () => setWidth(Math.floor(el.clientWidth - 20));
    measure();
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(measure, 120);
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  return (
    <div className="pdf-view" ref={box} aria-label="PDF preview">
      {!doc && <span className="spinner pdf-spinner" />}
      {doc && width > 0 && Array.from({ length: doc.numPages }, (_, i) => <PdfPage key={i} doc={doc} index={i + 1} width={width} root={box} />)}
      {doc && doc.numPages > 1 && <span className="pdf-count">{doc.numPages} pages</span>}
    </div>
  );
}

function PdfPage({ doc, index, width, root }: { doc: PDFDocumentProxy; index: number; width: number; root: React.RefObject<HTMLDivElement | null> }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(index <= 2);
  const [ratio, setRatio] = useState(1.414);

  // a closed PDF gives its page bitmaps back at once (WebKit keeps a canvas's pixels until GC)
  useEffect(() => {
    const c = canvas.current;
    return () => {
      if (c) {
        c.width = 0;
        c.height = 0;
      }
    };
  }, []);

  // draw only the pages near the viewport and free the others
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: root.current, rootMargin: "500px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    if (!near) {
      c.width = 0;
      c.height = 0;
      return;
    }
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let live = true;
    doc.getPage(index).then((page) => {
      if (!live) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: (width / base.width) * dpr });
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      const ctx = c.getContext("2d");
      if (!ctx) return;
      task = page.render({ canvasContext: ctx, viewport } as Parameters<typeof page.render>[0]);
      task.promise.catch(() => {});
    });
    return () => {
      live = false;
      task?.cancel();
    };
  }, [doc, index, width, near]);

  return (
    <div className="pdf-page" ref={wrap} style={{ width, height: Math.round(width * ratio) }}>
      <canvas ref={canvas} aria-label={`Page ${index}`} />
    </div>
  );
}
