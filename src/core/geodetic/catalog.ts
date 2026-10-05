/**
 * The geodetic-points catalogue: sources, horizontal datums and vertical
 * datums. Tiles carry small integers (`s`, `d`, `hd`) that index these lists.
 *
 * `catalog-v1.json` is written by the NAS pipeline
 * (`infra/tiles/nas/geodetic/catalog.py`, append-only) and bundled here, so a
 * card works offline with nothing to fetch; the Python tests fail when the
 * two drift.
 */
import raw from './catalog-v1.json';

export interface GeodeticSource {
  key: string;
  name: string;
  network: string;
  licence: string;
  /** The credit line for the card footer. */
  attribution: string;
  licenceUrl: string;
  /** Datasheet URL template (`{id}`), or null when the agency has no per-mark page. */
  sheet: string | null;
}

export interface GeodeticDatum {
  key: string;
  name: string;
  epoch: string | null;
  /** A current geocentric realization (solid symbol) vs legacy / local (hollow). */
  modern: boolean;
  /**
   * How far a position in this datum lands from WGS 84 when drawn as if it
   * were WGS 84 — the "±" of the card's "≈ WGS 84 (display)" line.
   */
  wgsOffsetM: number;
}

export interface VerticalDatum {
  name: string;
  /** `chart`: a hydrographic / tidal datum — never shown as an orthometric height. */
  kind: 'ortho' | 'chart';
}

export interface GeodeticCatalog {
  version: number;
  sources: readonly GeodeticSource[];
  datums: readonly GeodeticDatum[];
  vdatums: readonly VerticalDatum[];
}

export const GEODETIC_CATALOG: GeodeticCatalog = {
  version: raw.version,
  sources: raw.sources.map((s) => ({ ...s, sheet: s.sheet ?? null })),
  datums: raw.datums.map((d) => ({
    key: d.key,
    name: d.name,
    epoch: d.epoch ?? null,
    modern: d.modern,
    wgsOffsetM: d.wgsOffsetM,
  })),
  vdatums: raw.vdatums.map((v) => ({ name: v.name, kind: v.kind === 'chart' ? 'chart' : 'ortho' })),
};

/** The OpenStreetMap source index (its own tile layer, ODbL). */
export const OSM_SOURCE_INDEX = GEODETIC_CATALOG.sources.findIndex((s) => s.key === 'osm');

export function sourceAt(i: number | undefined): GeodeticSource | undefined {
  return i === undefined ? undefined : GEODETIC_CATALOG.sources[i];
}

export function datumAt(i: number | undefined): GeodeticDatum | undefined {
  return i === undefined ? undefined : GEODETIC_CATALOG.datums[i];
}

export function vdatumAt(i: number | undefined): VerticalDatum | undefined {
  return i === undefined ? undefined : GEODETIC_CATALOG.vdatums[i];
}
