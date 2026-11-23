/** Pure: what the S3 endpoint becomes when the region changes (no imports, so `node --test` can load it). */

/**
 * Follow the region only while the endpoint is still the one the preset derived from the old region
 * (or empty). A hand-typed endpoint (MinIO, an R2 account address, a VPC or proxy endpoint) is kept.
 */
export function endpointAfterRegion(derive: (region: string) => string, oldRegion: string, newRegion: string, current: string): string {
  const cur = current.trim();
  if (cur === "" || cur === derive(oldRegion)) return derive(newRegion);
  return current;
}
