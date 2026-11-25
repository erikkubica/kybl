/**
 * What to say when a copy or move between connections ends. One wording for computers and phones;
 * each host shows it as a toast with its own "Show" action.
 */
import { errSummary, type JobSummary } from "../../core/api";

/** "Everything in media-prod to Backups" reads as "everything in…" after "Copied". */
const lowerLead = (t: string) => (/^(Everything|All) /.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);

/** The toast for a job that just ended; null when there is nothing to say (cancelled by the user). */
export function jobFinishedToast(j: JobSummary): { kind: "success" | "error"; text: string } | null {
  const p = j.progress;
  const verbed = j.spec.mode === "move" ? "moved" : "copied";
  if (p.state === "done" && p.filesFailed > 0)
    return { kind: "error", text: `${j.title}: ${p.filesFailed.toLocaleString()} ${p.filesFailed === 1 ? "file" : "files"} couldn't be ${verbed}` };
  if (p.state === "done" && j.spec.mirror) return { kind: "success", text: `${j.title}: done` };
  if (p.state === "done") return { kind: "success", text: `${j.spec.mode === "move" ? "Moved" : "Copied"} ${lowerLead(j.title)}` };
  if (p.state === "failed") return { kind: "error", text: `${j.title} stopped: ${errSummary(p.error ?? "something went wrong")}` };
  // cancelled: the user did that themselves
  return null;
}
