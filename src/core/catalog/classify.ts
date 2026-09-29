import type { CatalogCategory, CatalogItem } from './schema';
import {
  CATALOG_ACTIVITIES,
  type CatalogActivity,
  type CatalogKind,
  type CatalogTerrain,
} from './taxonomy';

/**
 * The explorer classifier — pure, deterministic, run at manifest-build time
 * (`scripts/catalog/build-manifest.ts`). The app only reads its output, but it
 * also uses {@link itemKind} / {@link itemActivities} so an item's facets mean
 * the same thing on both sides.
 *
 * **The rule for activities is "evidence, not vibes".** An item gets an
 * activity only when something *about the product* says so:
 *
 * 1. **Keywords** in the title or tags (EN + FR, accent-folded, whole words) —
 *    but only for kinds whose titles *describe the product* (park, trail and
 *    hunting/fishing maps). A topographic, nautical, aerial, geological or
 *    historical sheet is titled with a **toponym**: "Moose Lake", "Trail
 *    Creek", "Camp Verde", "Fishing Bridge" say nothing about what the map is
 *    for, and matching them would put thousands of quads under the wrong
 *    activity.
 * 2. **Kind defaults**: a hunting-and-fishing map with no more specific word
 *    gets both.
 *
 * Topographic sheets therefore carry **no** stored activities. They reach the
 * explorer's activity tiles through {@link TERRAIN_ACTIVITY_AFFINITY} instead:
 * {@link itemActivities} derives activities from terrain for any item that has
 * none of its own ("a mountain topo is a hiking map"). That derivation is kept
 * out of the wire data on purpose — it is a browse rule, not a fact about the
 * sheet, and the UI can label it as such.
 */

/** Kind of every sheet a source publishes (all current bulk sources are topo series). */
export const SOURCE_KINDS: Readonly<Record<string, CatalogKind>> = {
  'usgs-ustopo': 'topo',
  'usfs-fstopo': 'topo',
  'nrcan-cantopo': 'topo',
  'ga-austopo': 'topo',
};

/** Legacy category → kind, for sources not in {@link SOURCE_KINDS} and old manifests. */
export const CATEGORY_KINDS: Readonly<Record<CatalogCategory, CatalogKind>> = {
  topo: 'topo',
  parks: 'park',
  geological: 'geological',
  aerial: 'aerial',
  forest: 'topo',
  hunting: 'hunting-fishing',
  touristic: 'trail',
  nautical: 'nautical',
  river: 'trail',
};

/** Kinds whose titles describe the product, so title keywords are evidence. */
const DESCRIPTIVE_KINDS: ReadonlySet<CatalogKind> = new Set(['park', 'trail', 'hunting-fishing']);

/**
 * Terrain → the activities its maps serve, used only for items with no
 * activity of their own. Deliberately short: each pairing is one a reader
 * would not argue with. Forest has none (it would be "everything").
 */
export const TERRAIN_ACTIVITY_AFFINITY: Readonly<Record<CatalogTerrain, CatalogActivity[]>> = {
  mountains: ['hiking'],
  glacier: ['climbing'],
  water: ['paddling', 'fishing'],
  coast: ['paddling'],
  forest: [],
};

/** Lower-case, strip accents, and turn punctuation into spaces. */
export function foldText(text: string): string {
  return ` ${text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/**
 * Whole-word (or whole-phrase) keywords per activity, already folded. Notes:
 * - `vtt` is **off-road**, not cycling: in Québec usage it is overwhelmingly
 *   "véhicule tout-terrain" (ATV); a mountain bike is "vélo de montagne".
 * - `lac`/`lake`/`river` alone are not fishing/paddling evidence ("Parc du
 *   Lac-Beauport" is a ski hill); `river run`/`descente` and the legacy
 *   `river` category are.
 * - `sentier`/`trail` mean hiking only when nothing more specific matched
 *   (see {@link GENERIC_TRAIL_WORDS}) — "sentiers de ski", "ATV trails".
 */
const ACTIVITY_KEYWORDS: Readonly<Record<CatalogActivity, readonly string[]>> = {
  hiking: [
    'hiking',
    'hike',
    'hikes',
    'randonnee',
    'randonnees',
    'rando',
    'pedestre',
    'backpacking',
    'trek',
    'trekking',
    'longue randonnee',
  ],
  ski: [
    'ski',
    'skis',
    'skiing',
    'ski de fond',
    'nordic',
    'nordique',
    'cross country',
    'backcountry ski',
    'hors piste',
    'telemark',
  ],
  snowshoe: ['snowshoe', 'snowshoes', 'snowshoeing', 'raquette', 'raquettes'],
  paddling: [
    'canoe',
    'canoes',
    'canoeing',
    'canot',
    'canots',
    'canot camping',
    'kayak',
    'kayaks',
    'kayaking',
    'paddle',
    'paddling',
    'pagaie',
    'portage',
    'portages',
    'whitewater',
    'eau vive',
    'river run',
    'river runs',
    'descente de riviere',
  ],
  cycling: [
    'velo',
    'velos',
    'bike',
    'bikes',
    'biking',
    'cycling',
    'cyclable',
    'cyclables',
    'mtb',
    'fatbike',
    'fat bike',
    'velo de montagne',
    'mountain bike',
    'bikepacking',
    'veloroute',
  ],
  hunting: [
    'hunting',
    'hunt',
    'hunter',
    'chasse',
    'chasseur',
    'chasseurs',
    'orignal',
    'moose hunting',
    'cerf',
    'chevreuil',
    'gros gibier',
    'petit gibier',
    'gibier',
    'wapiti',
    'game management unit',
    'gmu',
    'zec',
    'zecs',
    'pourvoirie',
  ],
  fishing: [
    'fishing',
    'angling',
    'fly fishing',
    'peche',
    'pecheur',
    'saumon',
    'salmon',
    'truite',
    'trout',
    'zec',
    'zecs',
    'pourvoirie',
  ],
  camping: [
    'camping',
    'campground',
    'campgrounds',
    'campsite',
    'campsites',
    'camping sauvage',
    'pret a camper',
    'bivouac',
  ],
  climbing: [
    'escalade',
    'climbing',
    'rock climbing',
    'bouldering',
    'via ferrata',
    'mountaineering',
  ],
  offroad: [
    'atv',
    'atvs',
    'vtt',
    'quad',
    'quads',
    'ohv',
    'ohvs',
    'off road',
    'offroad',
    'hors route',
    'mvum',
    'motor vehicle use',
    '4x4',
    'jeep',
    'motoneige',
    'snowmobile',
    'snowmobiling',
    'dirt bike',
  ],
};

/** Weak words: hiking only when the text matched no other activity. */
const GENERIC_TRAIL_WORDS = ['trail', 'trails', 'sentier', 'sentiers'];
/** Weak words: ski + snowshoe only when neither was named. */
const GENERIC_WINTER_WORDS = ['hiver', 'hivernal', 'hivernale', 'winter'];

const hasWord = (folded: string, word: string): boolean => folded.includes(` ${word} `);

export interface KindInput {
  sourceId: string;
  category: CatalogCategory;
  title: string;
}

/** An item's kind: historical by title, else its source's, else its category's. */
export function classifyKind(input: KindInput): CatalogKind {
  const folded = foldText(input.title);
  if (['historical', 'historique', 'historic', 'legacy'].some((w) => hasWord(folded, w))) {
    return 'historical';
  }
  return SOURCE_KINDS[input.sourceId] ?? CATEGORY_KINDS[input.category];
}

export interface ActivityInput {
  kind: CatalogKind;
  category?: CatalogCategory;
  title: string;
  tags?: readonly string[];
}

/** Evidence-based activities, in vocabulary order (empty when there is no evidence). */
export function classifyActivities(input: ActivityInput): CatalogActivity[] {
  const found = new Set<CatalogActivity>();
  // Tags are descriptive by nature; titles only for descriptive kinds.
  const texts = [...(input.tags ?? [])];
  if (DESCRIPTIVE_KINDS.has(input.kind)) texts.push(input.title);
  const folded = foldText(texts.join(' | '));

  for (const activity of CATALOG_ACTIVITIES) {
    if (ACTIVITY_KEYWORDS[activity].some((word) => hasWord(folded, word))) found.add(activity);
  }
  if (!found.has('ski') && !found.has('snowshoe')) {
    if (GENERIC_WINTER_WORDS.some((w) => hasWord(folded, w))) {
      found.add('ski');
      found.add('snowshoe');
    }
  }
  if (found.size === 0 && GENERIC_TRAIL_WORDS.some((w) => hasWord(folded, w))) {
    found.add('hiking');
  }
  if (input.category === 'river') found.add('paddling');
  if (input.kind === 'hunting-fishing' && !found.has('hunting') && !found.has('fishing')) {
    found.add('hunting');
    found.add('fishing');
  }
  return CATALOG_ACTIVITIES.filter((a) => found.has(a));
}

/** Kind for display/filtering: the stored one, else derived (old manifests). */
export function itemKind(
  item: Pick<CatalogItem, 'kind' | 'sourceId' | 'category' | 'title'>,
): CatalogKind {
  return item.kind ?? classifyKind(item);
}

/** Activities implied by a terrain list, in vocabulary order. */
export function terrainActivities(terrain: readonly CatalogTerrain[]): CatalogActivity[] {
  const implied = new Set(terrain.flatMap((t) => TERRAIN_ACTIVITY_AFFINITY[t]));
  return CATALOG_ACTIVITIES.filter((a) => implied.has(a));
}

/**
 * The activities the explorer browses an item under: its own evidence when it
 * has any, otherwise what its terrain implies. This — not the raw field — is
 * what the index's `activityCounts` counts, so a tile's number always equals
 * what tapping it lists.
 */
export function itemActivities(
  item: Pick<CatalogItem, 'activities' | 'terrain'>,
): CatalogActivity[] {
  if (item.activities !== undefined && item.activities.length > 0) return [...item.activities];
  return terrainActivities(item.terrain ?? []);
}

/** Whether the explorer lists `item` under `activity` (see {@link itemActivities}). */
export function itemMatchesActivity(
  item: Pick<CatalogItem, 'activities' | 'terrain'>,
  activity: CatalogActivity,
): boolean {
  return itemActivities(item).includes(activity);
}
