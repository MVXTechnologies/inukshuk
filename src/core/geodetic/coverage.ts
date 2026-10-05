/**
 * "Coverage & sources" (Settings → Extensions → Geodetic points): how many
 * marks each source contributes, and when the archive was built. The build
 * writes it into the archive's metadata `description`
 * (`{"v":1,"updated":"2026-10-05","counts":{"0":80322,…}}`), which the tile
 * Worker already serves in the archive's TileJSON (`/geodetic.json`) — no
 * extra endpoint, nothing to deploy.
 */
import { GEODETIC_CATALOG, type GeodeticSource } from './catalog';

export interface GeodeticCoverage {
  /** YYYY-MM-DD of the build. */
  updated: string;
  /** Source index → live marks in the archive. */
  counts: Map<number, number>;
}

/** Parse a TileJSON (or its description) into coverage; null when it isn't ours. */
export function parseGeodeticCoverage(tileJson: unknown): GeodeticCoverage | null {
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
  const { updated, counts } = parsed as { updated?: unknown; counts?: unknown };
  if (typeof updated !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(updated)) return null;
  const out = new Map<number, number>();
  if (typeof counts === 'object' && counts !== null) {
    for (const [k, v] of Object.entries(counts)) {
      const i = Number(k);
      if (Number.isInteger(i) && i >= 0 && typeof v === 'number' && v > 0) out.set(i, v);
    }
  }
  return { updated, counts: out };
}

export interface CoverageRow {
  source: GeodeticSource;
  marks: number;
}

/** Sources with marks, most first (catalogue order breaks ties). */
export function coverageRows(coverage: GeodeticCoverage): CoverageRow[] {
  const rows: CoverageRow[] = [];
  GEODETIC_CATALOG.sources.forEach((source, i) => {
    const marks = coverage.counts.get(i);
    if (marks !== undefined) rows.push({ source, marks });
  });
  return rows.sort((a, b) => b.marks - a.marks);
}

/** "24 agencies + OpenStreetMap" style summary for the settings row. */
export function coverageSummary(coverage: GeodeticCoverage | null): string {
  if (!coverage) return 'Official survey agencies + OpenStreetMap';
  const rows = coverageRows(coverage);
  const agencies = new Set(rows.filter((r) => r.source.key !== 'osm').map((r) => r.source.name));
  const osm = rows.some((r) => r.source.key === 'osm');
  const total = rows.reduce((n, r) => n + r.marks, 0);
  const who = `${agencies.size} ${agencies.size === 1 ? 'agency' : 'agencies'}${osm ? ' + OpenStreetMap' : ''}`;
  return `${who} · ${formatCount(total)} marks · updated ${coverage.updated}`;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)} M`;
  if (n >= 10_000) return `${Math.round(n / 1000)} k`;
  return n.toLocaleString('en-US');
}
