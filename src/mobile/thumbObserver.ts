/**
 * One IntersectionObserver for every thumbnail on screen, instead of one per row: a grid of a
 * few hundred photos otherwise keeps hundreds of observers busy on every scroll.
 */
const callbacks = new Map<Element, () => void>();
let io: IntersectionObserver | null = null;

function observer(): IntersectionObserver {
  io ??= new IntersectionObserver(
    (entries) => {
      for (const x of entries) {
        if (!x.isIntersecting) continue;
        const cb = callbacks.get(x.target);
        if (!cb) continue;
        callbacks.delete(x.target);
        io!.unobserve(x.target);
        cb();
      }
    },
    { rootMargin: "300px" },
  );
  return io;
}

/** Calls `onNear` once, when `el` comes within 300 px of the screen. Returns a cleanup. */
export function whenNear(el: Element, onNear: () => void): () => void {
  callbacks.set(el, onNear);
  observer().observe(el);
  return () => {
    if (callbacks.delete(el)) io?.unobserve(el);
  };
}
