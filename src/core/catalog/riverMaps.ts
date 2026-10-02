import type { CatalogBbox, CatalogFormat, CatalogItem, CatalogSource } from './schema';

/**
 * Québec river-descent maps: the pure half of the `quebec-rivers` catalog
 * source (`scripts/catalog/fetch-quebec-rivers.ts`).
 *
 * No publisher of river-descent maps has an index we can crawl. None of them
 * licenses its files either: every one checked on 2026-10-02 is "tous droits
 * réservés" or silent (docs/research/quebec-river-maps.md). So this source is
 * **hand-curated** and **permission-gated**:
 *
 * - The reviewed list (`scripts/catalog/sources/quebec-rivers.json`) names each
 *   map, the publisher's own URL and the map's footprint.
 * - Every publisher carries a `permission` block. Its maps reach the catalog
 *   only when the status is `granted` and the block quotes the evidence (the
 *   written permission or an open licence). A `pending` publisher's maps stay
 *   in the list, ready, and are never emitted.
 * - The generator only HEADs each URL for its real size and date. It never
 *   downloads or rehosts a map.
 *
 * Everything here is pure, so the rules are unit-tested:
 *
 * - {@link parseRiverMapList} validates the list. It never throws: a bad row
 *   is dropped with a warning, and a `granted` publisher without evidence is a
 *   bad row.
 * - {@link publishableRiverMaps} keeps only the maps whose publisher granted
 *   permission.
 * - {@link riverMapItem} builds the catalog row. It uses the legacy category
 *   `river`, which the classifier already reads as paddling evidence, and
 *   kind `trail`. The bbox puts it in "near you" and on the map browse.
 */

/** Québec's rough envelope (incl. Nunavik and the Magdalen Islands); extents outside are typos. */
const QUEBEC_ENVELOPE: CatalogBbox = [-79.8, 44.9, -57.0, 62.7];

/** A map wider or taller than this (degrees) is a regional locator, not a river map. */
export const MAX_RIVER_MAP_SPAN_DEG = 3;

export type RiverMapPermissionStatus = 'granted' | 'pending';

export interface RiverMapPermission {
  status: RiverMapPermissionStatus;
  /**
   * For `granted`: the quoted licence clause or written permission, with
   * where and when it was obtained. For `pending`: what is being asked, of whom.
   */
  evidence: string;
}

/** One publisher of river maps, declared once per curated list. */
export interface RiverMapPublisher extends CatalogSource {
  permission: RiverMapPermission;
}

/** One curated map. */
export interface RiverMapEntry {
  /** Stable slug, unique within the list (the catalog id is `qcriv-<slug>`). */
  slug: string;
  publisherId: string;
  title: string;
  /** River name as the Commission de toponymie spells it, e.g. "Rivière Victoria". */
  river: string;
  url: string;
  format: CatalogFormat;
  /** WGS84 [west, south, east, north] of the route's map sheets. */
  bbox: CatalogBbox;
  /** Where the bbox came from (e.g. "union of the file's GeoPDF /GPTS route sheets"). */
  bboxEvidence: string;
  lang?: 'fr' | 'en' | 'bilingual';
  /** Edition printed on the map (ISO date or year), used when the HEAD gives no date. */
  edition?: string;
}

export interface RiverMapList {
  publishers: RiverMapPublisher[];
  maps: RiverMapEntry[];
}

export interface RiverMapListParseResult {
  list: RiverMapList;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function httpsUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https:\/\/[^\s/]+\.[^\s]+$/.test(value) ? value : null;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A plausible single-route extent inside Québec, or null. */
export function riverMapBbox(value: unknown): CatalogBbox | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const [w, s, e, n] = value as [number, number, number, number];
  if (w >= e || s >= n) return null;
  if (e - w > MAX_RIVER_MAP_SPAN_DEG || n - s > MAX_RIVER_MAP_SPAN_DEG) return null;
  const [qw, qs, qe, qn] = QUEBEC_ENVELOPE;
  if (w < qw || e > qe || s < qs || n > qn) return null;
  return [w, s, e, n];
}

function parsePermission(raw: unknown): RiverMapPermission | null {
  if (!isRecord(raw)) return null;
  const evidence = text(raw.evidence);
  if (evidence === null) return null;
  if (raw.status !== 'granted' && raw.status !== 'pending') return null;
  return { status: raw.status, evidence };
}

function parsePublisher(raw: unknown): RiverMapPublisher | string {
  if (!isRecord(raw)) return 'publisher is not an object';
  const id = text(raw.id);
  if (id === null || !SLUG.test(id)) return `publisher with an unusable id "${String(raw.id)}"`;
  const name = text(raw.name);
  const licence = text(raw.licence);
  const attribution = text(raw.attribution);
  if (name === null || licence === null || attribution === null) {
    return `publisher "${id}": name, licence and attribution are required`;
  }
  // The whole point of the curated list: no recorded permission state, no publisher.
  const permission = parsePermission(raw.permission);
  if (permission === null) {
    return `publisher "${id}": permission needs a status (granted|pending) and evidence`;
  }
  const homepage = httpsUrl(raw.homepage);
  return {
    id,
    name,
    licence,
    attribution,
    ...(homepage !== null ? { homepage } : {}),
    permission,
  };
}

function parseEntry(raw: unknown, publisherIds: ReadonlySet<string>): RiverMapEntry | string {
  if (!isRecord(raw)) return 'map is not an object';
  const slug = text(raw.slug);
  if (slug === null || !SLUG.test(slug)) return `map with an unusable slug "${String(raw.slug)}"`;
  const publisherId = text(raw.publisherId);
  if (publisherId === null || !publisherIds.has(publisherId)) {
    return `map "${slug}": unknown publisher "${String(raw.publisherId)}"`;
  }
  const title = text(raw.title);
  const river = text(raw.river);
  if (title === null || river === null) return `map "${slug}": title and river are required`;
  const url = httpsUrl(raw.url);
  if (url === null) return `map "${slug}": missing or non-https url`;
  if (raw.format !== 'pdf' && raw.format !== 'geopdf') {
    return `map "${slug}": format must be "pdf" or "geopdf"`;
  }
  const bbox = riverMapBbox(raw.bbox);
  if (bbox === null) {
    return `map "${slug}": bbox must be [w, s, e, n] inside Québec, at most ${MAX_RIVER_MAP_SPAN_DEG}° across`;
  }
  const bboxEvidence = text(raw.bboxEvidence);
  if (bboxEvidence === null) return `map "${slug}": bboxEvidence is required`;
  const lang =
    raw.lang === 'fr' || raw.lang === 'en' || raw.lang === 'bilingual' ? raw.lang : undefined;
  const edition = text(raw.edition);
  return {
    slug,
    publisherId,
    title,
    river,
    url,
    format: raw.format,
    bbox,
    bboxEvidence,
    ...(lang !== undefined ? { lang } : {}),
    ...(edition !== null ? { edition } : {}),
  };
}

/** Validate the curated list. Never throws; bad rows are dropped with a warning each. */
export function parseRiverMapList(raw: unknown): RiverMapListParseResult {
  const warnings: string[] = [];
  const publishers: RiverMapPublisher[] = [];
  const maps: RiverMapEntry[] = [];
  if (!isRecord(raw)) return { list: { publishers, maps }, warnings: ['list is not an object'] };

  const publisherIds = new Set<string>();
  for (const rawPublisher of Array.isArray(raw.publishers) ? raw.publishers : []) {
    const publisher = parsePublisher(rawPublisher);
    if (typeof publisher === 'string') {
      warnings.push(`dropped ${publisher}`);
    } else if (publisherIds.has(publisher.id)) {
      warnings.push(`dropped duplicate publisher "${publisher.id}"`);
    } else {
      publisherIds.add(publisher.id);
      publishers.push(publisher);
    }
  }

  const slugs = new Set<string>();
  const urls = new Set<string>();
  for (const rawMap of Array.isArray(raw.maps) ? raw.maps : []) {
    const entry = parseEntry(rawMap, publisherIds);
    if (typeof entry === 'string') {
      warnings.push(`dropped ${entry}`);
    } else if (slugs.has(entry.slug)) {
      warnings.push(`dropped duplicate map "${entry.slug}"`);
    } else if (urls.has(entry.url)) {
      warnings.push(`dropped map "${entry.slug}": its url is already listed`);
    } else {
      slugs.add(entry.slug);
      urls.add(entry.url);
      maps.push(entry);
    }
  }
  return { list: { publishers, maps }, warnings };
}

/** The maps whose publisher has granted permission, and how many are still waiting. */
export function publishableRiverMaps(list: RiverMapList): {
  maps: RiverMapEntry[];
  pending: number;
} {
  const granted = new Set(
    list.publishers.filter((p) => p.permission.status === 'granted').map((p) => p.id),
  );
  const maps = list.maps.filter((m) => granted.has(m.publisherId));
  return { maps, pending: list.maps.length - maps.length };
}

/** What the generator learnt from HEADing the publisher's URL. */
export interface RiverMapHead {
  sizeBytes?: number;
  /** ISO date (YYYY-MM-DD) from Last-Modified. */
  updatedAt?: string;
}

/** The catalog row for one curated map. */
export function riverMapItem(entry: RiverMapEntry, head: RiverMapHead = {}): CatalogItem {
  const updatedAt = head.updatedAt ?? entry.edition;
  return {
    id: `qcriv-${entry.slug}`,
    sourceId: entry.publisherId,
    title: entry.title,
    category: 'river',
    kind: 'trail',
    activities: ['paddling'],
    region: 'CA-QC',
    format: entry.format,
    packaging: 'none',
    url: entry.url,
    bbox: entry.bbox,
    ...(head.sizeBytes !== undefined ? { sizeBytes: head.sizeBytes } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(entry.lang !== undefined ? { lang: entry.lang } : {}),
  };
}

/** Catalog sources for the given publisher ids (the permission record stays in the curated file). */
export function riverMapSources(
  list: RiverMapList,
  ids: ReadonlySet<string> = new Set(list.publishers.map((p) => p.id)),
): CatalogSource[] {
  return list.publishers
    .filter((p) => ids.has(p.id))
    .map(({ permission: _permission, ...source }) => source);
}

/** `Last-Modified` → ISO date, or undefined when absent or unparseable. */
export function lastModifiedDate(header: string | null | undefined): string | undefined {
  if (header === null || header === undefined) return undefined;
  const ms = Date.parse(header);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
}
