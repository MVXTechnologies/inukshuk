/**
 * "Coverage & sources" of the Tide stations extension: stations per source
 * from `tides.pmtiles`' description (served in `/tides.json`, the same
 * `{"v":1,"updated":…,"counts":{…}}` shape as the geodetic archive), plus
 * Canada, which the phone fetches live from CHS and never comes from our
 * archive (so it has no count here).
 */
import { parseGeodeticCoverage, type GeodeticCoverage } from '@core/geodetic/coverage';
import { TIDE_CATALOG, type TideSource } from './catalog';
import { CHS_SOURCE } from './chs';

export type TideCoverage = GeodeticCoverage;

export const parseTideCoverage = (tileJson: unknown): TideCoverage | null =>
  parseGeodeticCoverage(tileJson);

export interface TideCoverageRow {
  source: TideSource;
  /** Stations in our archive; null = live from the agency (CHS). */
  stations: number | null;
}

export function tideCoverageRows(c: TideCoverage | null): TideCoverageRow[] {
  const ours = TIDE_CATALOG.sources.map((source, i) => ({
    source,
    stations: c?.counts.get(i) ?? 0,
  }));
  return [
    { source: CHS_SOURCE, stations: null },
    ...ours.filter((r) => c === null || r.stations > 0).sort((a, b) => b.stations - a.stations),
  ];
}

export function tideCoverageSummary(c: TideCoverage | null): string {
  if (c === null) return 'Canada (live from CHS) · USA · France · Norway · Japan';
  const total = [...c.counts.values()].reduce((a, b) => a + b, 0);
  return `${total.toLocaleString('en-US')} stations + Canada live from CHS · updated ${c.updated}`;
}
