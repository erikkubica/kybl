/** Parses CSV/TSV off the main thread, so a 50 MB file doesn't freeze the window. */
import Papa from "papaparse";

export type CsvRequest = { id: number; text: string; delimiter: string };
export type CsvResponse = { id: number; rows: string[][]; error: string | null };

self.onmessage = (ev: MessageEvent<CsvRequest>) => {
  const { id, text, delimiter } = ev.data;
  try {
    const out = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: "greedy" });
    // a malformed quote is reported but the rest still parses: show what we have
    const bad = out.errors.find((e) => e.type === "Quotes");
    const msg: CsvResponse = { id, rows: out.data, error: bad ? `Row ${(bad.row ?? 0) + 1}: ${bad.message}` : null };
    (self as unknown as Worker).postMessage(msg);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, rows: [], error: String(e) } satisfies CsvResponse);
  }
};
