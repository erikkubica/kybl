/**
 * Pure: whether a thumbnail that failed is asked for again. The network coming back retries every
 * failure; the app coming back to the front (which happens all the time) only retries failures
 * made offline or a while ago, so an undecodable 40 MB PNG isn't downloaded again on every switch.
 */
export function retryFailure(why: "online" | "resumed", failedAt: number, offline: boolean, now: number, after: number): boolean {
  return why === "online" || offline || now - failedAt >= after;
}
