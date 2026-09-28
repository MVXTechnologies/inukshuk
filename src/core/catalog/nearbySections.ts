import type { Units } from '@core/format';
import type { LatLng } from '@core/models';
import { formatByteSize } from '@core/storage/diskBudget';
import { nearbyCatalogItems, type NearbyCatalogItem } from './nearby';
import { sortCatalogItems } from './nearest';
import type { CatalogItem } from './schema';

/**
 * The Explore tab landing (revamp `After-Maps.html`, spec §6): **Canadian sources
 * first**, then the nearest US quads "across the border", each group sorted by
 * distance.
 *
 * Why grouping and not one distance-sorted list: CanTopo does not cover the
 * Québec City area (NTS 021L is unpublished), so from Québec the nearest
 * CanTopo sheet is ~318 km away while Maine's US Topo quads start at ~100 km —
 * a plain nearest-first list showed only Maine quads, which reads as "this app
 * has no Canadian maps". The groups make the source explicit instead.
 *
 * Pure: the screen passes `settingsStore.lastKnownPosition` (or null) in.
 */

/** Which national group a catalog item belongs to on the landing. */
export type CatalogCountry = 'CA' | 'US' | 'other';

/** Source-id prefixes whose publisher is national, for items without a region. */
const CANADIAN_SOURCE = /^(nrcan|cantopo|canmatrix|parks-canada|chs)-/;
const US_SOURCE = /^(usgs|noaa|nps|usfs)-/;

/**
 * An item's country: its ISO 3166-2 `region` when it has one ("CA-QC",
 * "US-ME"), else its source (CanTopo items carry no region at all).
 */
export function catalogItemCountry(item: Pick<CatalogItem, 'region' | 'sourceId'>): CatalogCountry {
  const region = item.region?.toUpperCase();
  if (region !== undefined) {
    if (region === 'CA' || region.startsWith('CA-')) return 'CA';
    if (region === 'US' || region.startsWith('US-')) return 'US';
    return 'other';
  }
  if (CANADIAN_SOURCE.test(item.sourceId)) return 'CA';
  if (US_SOURCE.test(item.sourceId)) return 'US';
  return 'other';
}

/** One landing section: a titled, distance-sorted group. */
export interface NearbySection {
  country: CatalogCountry;
  title: string;
  entries: NearbyCatalogItem[];
}

export interface NearbySectionOptions {
  /** Rows per group. The Canadian group leads, so it gets the most. */
  limits?: Partial<Record<CatalogCountry, number>>;
  radiusMeters?: number;
}

/** Board: three CanTopo rows, then two USGS quads; a little headroom on each. */
export const DEFAULT_SECTION_LIMITS: Record<CatalogCountry, number> = { CA: 5, US: 3, other: 5 };

const ORDER: readonly CatalogCountry[] = ['CA', 'US', 'other'];

/** Heading for a group, given whether a group was already shown above it. */
function sectionTitle(
  country: CatalogCountry,
  entries: readonly NearbyCatalogItem[],
  afterAnother: boolean,
): string {
  if (!afterAnother) {
    return country === 'CA' ? 'Near you · Canadian sources first' : 'Near you';
  }
  if (country === 'US') {
    const allUsgs = entries.every((e) => e.item.sourceId.startsWith('usgs-'));
    return allUsgs
      ? 'Nearest USGS quads · across the border'
      : 'Nearest US maps · across the border';
  }
  return 'Also nearby';
}

/**
 * The landing's sections: Canadian items nearest-first, then US items
 * nearest-first, then anything else. Empty groups are omitted, so a user in
 * Australia simply gets one "Near you" section. Within each group the
 * per-category mixing of {@link nearbyCatalogItems} still applies (a
 * nautical chart is not crowded out by five adjacent topo sheets).
 *
 * `[]` without a known position — the screen then shows only the category
 * grid, which still browses the whole world.
 */
export function nearbySections(
  items: readonly CatalogItem[],
  origin: LatLng | null,
  options?: NearbySectionOptions,
): NearbySection[] {
  if (origin === null) return [];
  const byCountry: Record<CatalogCountry, CatalogItem[]> = { CA: [], US: [], other: [] };
  for (const item of items) byCountry[catalogItemCountry(item)].push(item);

  const sections: NearbySection[] = [];
  for (const country of ORDER) {
    const limit = options?.limits?.[country] ?? DEFAULT_SECTION_LIMITS[country];
    const entries = nearbyCatalogItems(byCountry[country], origin, {
      limit,
      ...(options?.radiusMeters !== undefined ? { radiusMeters: options.radiusMeters } : {}),
    });
    if (entries.length === 0) continue;
    sections.push({
      country,
      title: sectionTitle(country, entries, sections.length > 0),
      entries,
    });
  }
  return sections;
}

/**
 * The browse/search list's order: the same Canadian → US → other grouping as
 * the landing, nearest-first within each group (so browsing Topo from Québec
 * City no longer opens on Maine). Without a position there is nothing to be
 * "near", and the list stays plain alphabetical, ungrouped.
 */
export function sortCatalogItemsCanadianFirst(
  items: readonly CatalogItem[],
  origin: LatLng | null,
): CatalogItem[] {
  const sorted = sortCatalogItems(items, origin);
  if (origin === null) return sorted;
  const rank = (item: CatalogItem) => ORDER.indexOf(catalogItemCountry(item));
  // Array#sort is stable, so the nearest-first order survives inside a group.
  return sorted.sort((a, b) => rank(a) - rank(b));
}

const M_PER_MI = 1609.344;

/**
 * "12 km away": a row's distance, rounded to whole kilometres (miles) — the
 * old two-decimal "≈ 12.34 km" read like a database dump. Anything under one
 * unit reads "< 1 km away" rather than a misleading "0 km".
 */
export function formatDistanceAway(meters: number, units: Units): string {
  const unit = units === 'imperial' ? 'mi' : 'km';
  if (!Number.isFinite(meters) || meters < 0) return `< 1 ${unit} away`;
  const value = meters / (units === 'imperial' ? M_PER_MI : 1000);
  const rounded = Math.round(value);
  if (rounded < 1) return `< 1 ${unit} away`;
  const grouped = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped} ${unit} away`;
}

/** Row meta line: `31 MB · 12 km away`, with whichever half is known. */
export function catalogRowMeta(
  sizeBytes: number | undefined,
  distanceMeters: number | null | undefined,
  units: Units,
): string {
  return [
    sizeBytes !== undefined ? formatByteSize(sizeBytes) : undefined,
    distanceMeters != null ? formatDistanceAway(distanceMeters, units) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
}

const REGION_NAMES: Record<string, string> = {
  'CA-AB': 'Alberta',
  'CA-BC': 'British Columbia',
  'CA-MB': 'Manitoba',
  'CA-NB': 'New Brunswick',
  'CA-NL': 'Newfoundland and Labrador',
  'CA-NS': 'Nova Scotia',
  'CA-NT': 'Northwest Territories',
  'CA-NU': 'Nunavut',
  'CA-ON': 'Ontario',
  'CA-PE': 'Prince Edward Island',
  'CA-QC': 'Québec',
  'CA-SK': 'Saskatchewan',
  'CA-YT': 'Yukon',
  'US-AK': 'Alaska',
  'US-AL': 'Alabama',
  'US-AR': 'Arkansas',
  'US-AZ': 'Arizona',
  'US-CA': 'California',
  'US-CO': 'Colorado',
  'US-CT': 'Connecticut',
  'US-DC': 'District of Columbia',
  'US-DE': 'Delaware',
  'US-FL': 'Florida',
  'US-GA': 'Georgia',
  'US-HI': 'Hawaii',
  'US-IA': 'Iowa',
  'US-ID': 'Idaho',
  'US-IL': 'Illinois',
  'US-IN': 'Indiana',
  'US-KS': 'Kansas',
  'US-KY': 'Kentucky',
  'US-LA': 'Louisiana',
  'US-MA': 'Massachusetts',
  'US-MD': 'Maryland',
  'US-ME': 'Maine',
  'US-MI': 'Michigan',
  'US-MN': 'Minnesota',
  'US-MO': 'Missouri',
  'US-MS': 'Mississippi',
  'US-MT': 'Montana',
  'US-NC': 'North Carolina',
  'US-ND': 'North Dakota',
  'US-NE': 'Nebraska',
  'US-NH': 'New Hampshire',
  'US-NJ': 'New Jersey',
  'US-NM': 'New Mexico',
  'US-NV': 'Nevada',
  'US-NY': 'New York',
  'US-OH': 'Ohio',
  'US-OK': 'Oklahoma',
  'US-OR': 'Oregon',
  'US-PA': 'Pennsylvania',
  'US-PR': 'Puerto Rico',
  'US-RI': 'Rhode Island',
  'US-SC': 'South Carolina',
  'US-SD': 'South Dakota',
  'US-TN': 'Tennessee',
  'US-TX': 'Texas',
  'US-UT': 'Utah',
  'US-VA': 'Virginia',
  'US-VT': 'Vermont',
  'US-WA': 'Washington',
  'US-WI': 'Wisconsin',
  'US-WV': 'West Virginia',
  'US-WY': 'Wyoming',
};

/**
 * Row source caption: "NRCan CanTopo", or "USGS US Topo · Maine" when the item
 * carries a region we can name. Unknown region codes are left out rather than
 * shown raw.
 */
export function catalogSourceCaption(
  sourceName: string | undefined,
  region: string | undefined,
): string {
  const regionName = region !== undefined ? REGION_NAMES[region.toUpperCase()] : undefined;
  return [sourceName, regionName].filter((p): p is string => p !== undefined).join(' · ');
}
