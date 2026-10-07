/**
 * "Coverage & sources" (Settings → Extensions → Climbing crags) and the topo
 * version, from the archive's metadata `description` (`climbing.sh` passes
 * `publish.description`), served by the Worker in the TileJSON
 * (`/crags.json`) — no extra endpoint:
 *
 *   {"crags":10550,"routes":231937,"version":"202610052200","ordered":312,
 *    "sources":{"ob":{"crags":…,"routes":…},"osm":{…},"c2c":{…}}}
 *
 * `version` names the topos' details object (/climbing/v1/d/{version}/{uid}.json).
 */
export interface ClimbingSourceRow {
  key: 'ob' | 'osm' | 'c2c';
  name: string;
  licence: string;
  url: string;
  crags: number;
  routes: number;
}

export interface ClimbingCoverage {
  crags: number;
  routes: number;
  version: string;
  ordered: number;
  sources: ClimbingSourceRow[];
}

const SOURCES: Omit<ClimbingSourceRow, 'crags' | 'routes'>[] = [
  { key: 'ob', name: 'OpenBeta', licence: 'CC0 1.0', url: 'https://openbeta.io' },
  {
    key: 'osm',
    name: 'OpenStreetMap contributors',
    licence: 'ODbL 1.0',
    url: 'https://www.openstreetmap.org/copyright',
  },
  {
    key: 'c2c',
    name: 'camptocamp.org',
    licence: 'CC BY-SA 3.0',
    url: 'https://www.camptocamp.org/articles/106728',
  },
];

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

export function parseClimbingCoverage(tileJson: unknown): ClimbingCoverage | null {
  const desc =
    typeof tileJson === 'object' && tileJson !== null && 'description' in tileJson
      ? (tileJson as { description: unknown }).description
      : tileJson;
  let parsed: unknown = desc;
  if (typeof desc === 'string') {
    try {
      parsed = JSON.parse(desc);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.version !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(p.version)) return null;
  const by = (typeof p.sources === 'object' && p.sources !== null ? p.sources : {}) as Record<
    string,
    Record<string, unknown> | undefined
  >;
  return {
    crags: num(p.crags),
    routes: num(p.routes),
    version: p.version,
    ordered: num(p.ordered),
    sources: SOURCES.map((s) => ({
      ...s,
      crags: num(by[s.key]?.crags),
      routes: num(by[s.key]?.routes),
    })),
  };
}

/** "10,550 crags · 231,937 routes, from 3 open sources". */
export function coverageSummary(c: ClimbingCoverage | null): string {
  if (c === null) return 'Counts load when you are online';
  const n = (v: number) => v.toLocaleString('en-US');
  const used = c.sources.filter((s) => s.crags > 0).length;
  return `${n(c.crags)} crags · ${n(c.routes)} routes, from ${used} open source${used === 1 ? '' : 's'}`;
}
