/**
 * A ref for previews' <img>, <video> and <audio>: when the element goes away its resource is let
 * go at once. WebKit otherwise keeps a removed video's buffers and a full-size photo's decoded
 * pixels (~48 MB for 12 MP) until it feels memory pressure, so browsing photos and videos grew
 * the web view to a gigabyte and more.
 */
export function releaseOnUnmount(el: HTMLImageElement | HTMLMediaElement | null) {
  if (!el) return;
  return () => {
    // only once it has really left the page: React also detaches refs from elements that stay
    // (dev mode's double mount), and stripping those would blank a live preview
    setTimeout(() => {
      if (!el.isConnected) release(el);
    });
  };
}

function release(el: HTMLImageElement | HTMLMediaElement) {
  if (el instanceof HTMLMediaElement) {
    el.pause();
    el.removeAttribute("src");
    el.load(); // drops the buffered media
  } else {
    el.removeAttribute("src");
  }
}
