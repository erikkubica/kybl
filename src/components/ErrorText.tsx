import { errDetail, errSummary } from "../api";

/**
 * An error as people should see it: the plain sentence, and the technical text folded away under
 * "Details" (still selectable, for bug reports).
 */
export function ErrorText({ message }: { message: string }) {
  const detail = errDetail(message);
  return (
    <span className="err-text">
      <span className="selectable">{errSummary(message)}</span>
      {detail && (
        <details className="err-details" onClick={(e) => e.stopPropagation()}>
          <summary>Details</summary>
          <pre className="selectable">{detail}</pre>
        </details>
      )}
    </span>
  );
}
