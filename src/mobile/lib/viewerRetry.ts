/**
 * What the viewer does when a video fails to play. A dropped connection or an expired link fails
 * the same way as a format the web view can't decode, so the first failure is treated like a photo
 * that didn't load (Try again fetches a fresh link); only a failure after asking again sends the
 * user to another app.
 */
export function videoErrorStep(failures: number): "retry" | "fallback" {
  return failures <= 1 ? "retry" : "fallback";
}
