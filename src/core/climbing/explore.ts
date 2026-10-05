/**
 * Explore → Climbing (mockup 01): the crags the map shows, as a list. They
 * come from the rendered tile features (nothing loads a worldwide list), are
 * de-duplicated (a crag can sit in two tiles), narrowed by the filter field,
 * sorted nearest the centre first and capped.
 */
import { parseCragTile, type CragSummary } from './crag';
import { nameMatches } from './search';

export const CRAG_SHEET_ROWS = 50;

export interface LatLng {
  latitude: number;
  longitude: number;
}

function dist2(c: CragSummary, o: LatLng): number {
  const k = Math.cos((o.latitude * Math.PI) / 180);
  const dx = (c.lng - o.longitude) * k;
  const dy = c.lat - o.latitude;
  return dx * dx + dy * dy;
}

export function cragsFromFeatures(
  features: readonly { properties?: Record<string, unknown> | null; geometry?: unknown }[],
  options: { centre: LatLng | null; text?: string; limit?: number },
): CragSummary[] {
  const byUid = new Map<string, CragSummary>();
  for (const f of features) {
    const c = parseCragTile(f as Parameters<typeof parseCragTile>[0]);
    if (c === null || byUid.has(c.uid)) continue;
    if (options.text && !nameMatches(c.name, options.text)) continue;
    byUid.set(c.uid, c);
  }
  const out = [...byUid.values()];
  const centre = options.centre;
  if (centre !== null) out.sort((a, b) => dist2(a, centre) - dist2(b, centre));
  return out.slice(0, options.limit ?? Number.POSITIVE_INFINITY);
}

/** "17 crags in this area · 515 routes". */
export function cragAreaLabel(crags: readonly CragSummary[]): string {
  const routes = crags.reduce((n, c) => n + c.routes, 0);
  const n = crags.length;
  if (n === 0) return 'No crags in this area';
  return `${n} ${n === 1 ? 'crag' : 'crags'} in this area · ${routes.toLocaleString('en-US')} ${
    routes === 1 ? 'route' : 'routes'
  }`;
}
