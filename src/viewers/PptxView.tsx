/**
 * PowerPoint, read-only: the cover picture PowerPoint stores in the file, then every slide's title
 * and text in order (plus its first picture, when it has one). Drawing real slides needs a layout
 * engine; this outline is enough to see what a deck says before opening it in another app.
 */
import { useEffect, useState } from "react";
import JSZip from "jszip";
import { Note } from "./ui";
import type { ViewerProps } from "./types";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

type Para = { text: string; level: number };
type Slide = { n: number; title: string; paras: Para[]; picture: string | null };
type Deck = { cover: string | null; slides: Slide[] };

const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

function xml(text: string): Document {
  return new DOMParser().parseFromString(text, "application/xml");
}

/** Relationship id → target path, resolved against the part's folder. */
async function rels(zip: JSZip, part: string): Promise<Map<string, string>> {
  const dir = part.slice(0, part.lastIndexOf("/") + 1);
  const relPath = `${dir}_rels/${part.slice(dir.length)}.rels`;
  const src = await zip.file(relPath)?.async("string");
  const out = new Map<string, string>();
  if (!src) return out;
  for (const r of Array.from(xml(src).getElementsByTagName("Relationship"))) {
    const target = r.getAttribute("Target") ?? "";
    out.set(r.getAttribute("Id") ?? "", target.startsWith("/") ? target.slice(1) : normalize(dir + target));
  }
  return out;
}

/** "ppt/slides/../media/a.png" → "ppt/media/a.png" */
function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  }
  return out.join("/");
}

async function imageUrl(zip: JSZip, path: string): Promise<string | null> {
  const type = IMAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
  const f = zip.file(path);
  if (!type || !f) return null;
  return URL.createObjectURL(new Blob([await f.async("uint8array") as BlobPart], { type }));
}

async function readDeck(bytes: Uint8Array): Promise<Deck> {
  const zip = await JSZip.loadAsync(bytes);
  // slide order comes from presentation.xml, not from the file names
  const pres = await zip.file("ppt/presentation.xml")?.async("string");
  const presRels = await rels(zip, "ppt/presentation.xml");
  let parts: string[] = [];
  if (pres) {
    parts = Array.from(xml(pres).getElementsByTagNameNS(P, "sldId"))
      .map((s) => presRels.get(s.getAttributeNS(R, "id") ?? "") ?? "")
      .filter((p) => p && zip.file(p));
  }
  if (!parts.length) {
    parts = Object.keys(zip.files)
      .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  }

  const slides: Slide[] = [];
  for (const [i, part] of parts.entries()) {
    const doc = xml((await zip.file(part)?.async("string")) ?? "");
    let title = "";
    const paras: Para[] = [];
    const titleShapes = new Set<Element>();
    for (const sp of Array.from(doc.getElementsByTagNameNS(P, "sp"))) {
      const ph = sp.getElementsByTagNameNS(P, "ph")[0];
      const type = ph?.getAttribute("type");
      if (type === "title" || type === "ctrTitle") {
        titleShapes.add(sp);
        title ||= Array.from(sp.getElementsByTagNameNS(A, "t"))
          .map((t) => t.textContent)
          .join("")
          .trim();
      }
    }
    for (const p of Array.from(doc.getElementsByTagNameNS(A, "p"))) {
      let inTitle = false;
      for (let e: Element | null = p; e; e = e.parentElement) if (titleShapes.has(e)) inTitle = true;
      if (inTitle) continue;
      const text = Array.from(p.getElementsByTagNameNS(A, "t"))
        .map((t) => t.textContent)
        .join("")
        .trim();
      if (!text) continue;
      const lvl = Number(p.getElementsByTagNameNS(A, "pPr")[0]?.getAttribute("lvl") ?? 0);
      paras.push({ text, level: Math.min(4, lvl || 0) });
    }
    let picture: string | null = null;
    const blip = doc.getElementsByTagNameNS(A, "blip")[0];
    const embed = blip?.getAttributeNS(R, "embed");
    if (embed) {
      const target = (await rels(zip, part)).get(embed);
      if (target) picture = await imageUrl(zip, target);
    }
    slides.push({ n: i + 1, title, paras, picture });
  }
  const cover = (await imageUrl(zip, "docProps/thumbnail.jpeg")) ?? (await imageUrl(zip, "docProps/thumbnail.png"));
  return { cover, slides };
}

export default function PptxView({ bytes, mode }: ViewerProps) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    let made: Deck | null = null;
    readDeck(bytes)
      .then((d) => {
        made = d;
        if (live) setDeck(d);
      })
      .catch(() => live && setError(true));
    return () => {
      live = false;
      // the pictures are object URLs: free them with the view
      if (made) for (const u of [made.cover, ...made.slides.map((s) => s.picture)]) if (u) URL.revokeObjectURL(u);
    };
  }, [bytes]);

  if (error) return <Note icon="alert">This presentation couldn't be read. It may be damaged, or saved in the older .ppt format.</Note>;
  if (!deck) return <Note spinner>Reading the slides…</Note>;
  return (
    <div className={`dv-viewer dv-pptx ${mode}`}>
      <div className="dv-pptx-inner selectable">
        {deck.cover && <img className="dv-pptx-cover" src={deck.cover} alt="First slide" />}
        <p className="dv-pptx-count">
          {deck.slides.length} {deck.slides.length === 1 ? "slide" : "slides"}
        </p>
        <ol className="dv-pptx-slides">
          {deck.slides.map((s) => (
            <li key={s.n}>
              <div className="dv-pptx-n">{s.n}</div>
              <div className="dv-pptx-body">
                <h4>{s.title || (s.paras[0]?.text ?? "Untitled slide")}</h4>
                {s.paras.length > 0 && (
                  <ul>
                    {(s.title ? s.paras : s.paras.slice(1)).slice(0, mode === "full" ? 200 : 6).map((p, i) => (
                      <li key={i} style={{ marginLeft: p.level * 16 }}>
                        {p.text}
                      </li>
                    ))}
                  </ul>
                )}
                {s.picture && mode === "full" && <img className="dv-pptx-pic" src={s.picture} alt="" loading="lazy" />}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
