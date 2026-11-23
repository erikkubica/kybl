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

export type PresetShape = { endpoint: (region: string) => string; defaultRegion: string; pathStyle: boolean; regions?: { value: string }[] };
export type S3Fields = { region: string; endpoint: string; pathStyle: boolean };

/**
 * What region, endpoint and path-style become when another provider preset is picked. Values the
 * old preset filled in (its default region, a region from its list, its derived endpoint, its
 * path-style default) follow the new preset; anything the user typed or changed is kept.
 */
export function fieldsAfterProvider(from: PresetShape, to: PresetShape, cur: S3Fields): S3Fields {
  if (from === to) return cur;
  const region = cur.region.trim();
  const listed = (p: PresetShape) => !!p.regions?.some((r) => r.value === region);
  const fromPreset = !region || region === from.defaultRegion || listed(from);
  const nextRegion = fromPreset || (to.regions && !listed(to)) ? to.defaultRegion : cur.region;
  const ep = cur.endpoint.trim();
  const endpoint = ep === "" || ep === from.endpoint(cur.region) ? to.endpoint(nextRegion) : cur.endpoint;
  const pathStyle = cur.pathStyle === from.pathStyle ? to.pathStyle : cur.pathStyle;
  return { region: nextRegion, endpoint, pathStyle };
}
