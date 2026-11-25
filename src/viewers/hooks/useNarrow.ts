import { useEffect, useState } from "react";

const query = "(max-width: 700px)";

/** True on phone-sized screens (and narrow windows), where two panes side by side don't fit. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** Touch screens: read-only text shouldn't pop up the keyboard when tapped. */
export const coarsePointer = () => window.matchMedia("(pointer: coarse)").matches;
