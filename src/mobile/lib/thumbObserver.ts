/**
 * One IntersectionObserver per scrolling list for every thumbnail in it, instead of one per row:
 * a grid of a few hundred photos otherwise keeps hundreds of observers busy on every scroll.
 *
 * The observer is rooted at the list's own scroller. Rooted at the screen instead, the 300 px
 * margin would do nothing: rows below the scroller's edge are clipped by it, so they would only
 * count as near once they were already on screen.
 */
const callbacks = new Map<Element, () => void>();
const observers = new WeakMap<Element | Document, IntersectionObserver>();

function observer(root: Element | null): IntersectionObserver {
  const k = root ?? document;
  let io = observers.get(k);
  if (!io) {
    const made: IntersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const x of entries) {
          if (!x.isIntersecting) continue;
          const cb = callbacks.get(x.target);
          if (!cb) continue;
          callbacks.delete(x.target);
          made.unobserve(x.target);
          cb();
        }
      },
      { root, rootMargin: "300px" },
    );
    io = made;
    observers.set(k, io);
  }
  return io;
}

/** Calls `onNear` once, when `el` comes within 300 px of its list's visible part. Returns a cleanup. */
export function whenNear(el: Element, onNear: () => void): () => void {
  const io = observer(el.closest(".m-scroll"));
  callbacks.set(el, onNear);
  io.observe(el);
  return () => {
    if (callbacks.delete(el)) io.unobserve(el);
  };
}
