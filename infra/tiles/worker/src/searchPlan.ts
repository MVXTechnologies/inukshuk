/**
 * Which Photon queries answer one place search (#496 feedback). Photon is a
 * general geocoder: "katahdin" finds streets and streams but not the
 * mountain, whose OSM name is "Mount Katahdin" (`natural=massif`), and a typo
 * ("katadhin") finds villages in Japan. So one search becomes up to three
 * upstream queries, run in parallel and merged:
 *
 * - **general** — what the user typed (a trailing generic word moved to the
 *   front: "katahdin mount" → "mount katahdin"), with the shop/office filters.
 * - **expanded** — restricted to summits (or to water, for a water word) and
 *   with the generic word: the user's own ("mont st anne", "lac saint-jean"),
 *   or "mount"/"mont" when they typed none. Photon tolerates a typo far better
 *   with a second word to anchor it: "mount katadhin" finds Mount Katahdin
 *   where "katadhin" alone finds nothing.
 * - **core** — the distinctive words alone ("katahdin"), restricted to
 *   summits, water and towns. It runs in the *second* language when one is
 *   asked, and doubles as the source of EN/FR names (`alt_name`) for every
 *   result it shares with the other two.
 *
 * Kept free of platform APIs: unit-tested in Node (`search.test.ts`).
 */

export type Hint = 'peak' | 'water';
export type TagSet = 'general' | 'peak' | 'water' | 'outdoor';

export interface PlannedQuery {
  role: 'general' | 'expanded' | 'core';
  text: string;
  lang: string;
  tags: TagSet;
}

/** Hard cap on upstream calls for one search (Photon fair use). */
export const MAX_UPSTREAM_CALLS = 3;

const PEAK_WORDS = new Set([
  'mount',
  'mt',
  'mont',
  'monte',
  'mountain',
  'mtn',
  'montagne',
  'pic',
  'pico',
  'peak',
  'pk',
]);
const WATER_WORDS = new Set(['lac', 'lake', 'etang', 'pond', 'lago', 'loch']);

/** Summits, mountains, ranges. Photon ORs several include filters. */
export const PEAK_TAGS = [
  'natural:peak',
  'natural:massif',
  'natural:mountain_range',
  'natural:volcano',
  'natural:ridge',
  'natural:hill',
];
/** Lakes, ponds, reservoirs (`water=*`), bays and rivers. */
export const WATER_TAGS = [
  'natural:water',
  'water',
  'natural:bay',
  'landuse:reservoir',
  'waterway:river',
];
/** Towns, so the second language also names the town the user meant. */
const TOWN_TAGS = ['place:city', 'place:town', 'place:village'];

export function tagsFor(set: Exclude<TagSet, 'general'>): string[] {
  if (set === 'peak') return PEAK_TAGS;
  if (set === 'water') return WATER_TAGS;
  return [...PEAK_TAGS, ...WATER_TAGS, ...TOWN_TAGS];
}

const fold = (w: string) => w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export interface QueryShape {
  /** What the general query sends: the generic word first, else as typed. */
  canonical: string;
  /** The distinctive words, generic words removed ("" when there are none). */
  core: string;
  hint: Hint | null;
  /** The generic word as typed, or null. */
  generic: string | null;
}

/** Find the generic word ("mount", "lac" …) in a query, wherever it is. */
export function queryShape(q: string): QueryShape {
  // Hyphens separate words here ("Mont-Sainte-Anne" starts with "Mont"), but
  // the text sent upstream keeps the user's spelling where it can.
  const words = q.split(/[\s\-‐-―]+/).filter((w) => w !== '');
  const at = words.findIndex((w) => PEAK_WORDS.has(fold(w)) || WATER_WORDS.has(fold(w)));
  if (at < 0) return { canonical: q, core: q, hint: null, generic: null };
  const generic = words[at] ?? '';
  const hint: Hint = PEAK_WORDS.has(fold(generic)) ? 'peak' : 'water';
  const rest = words.filter(
    (w, i) => i !== at && !PEAK_WORDS.has(fold(w)) && !WATER_WORDS.has(fold(w)),
  );
  const core = rest.join(' ');
  const canonical = at === 0 || core === '' ? q : `${generic} ${core}`;
  return { canonical, core, hint, generic };
}

/**
 * The upstream queries for one search, at most {@link MAX_UPSTREAM_CALLS}.
 * `variants: false` is the plain behaviour: the query as typed, plus the
 * second language when asked.
 */
export function planSearch(
  q: string,
  lang: string,
  alt: string | null,
  variants = true,
): PlannedQuery[] {
  const shape = queryShape(q);
  const general: PlannedQuery = { role: 'general', text: shape.canonical, lang, tags: 'general' };
  if (!variants || shape.core === '') {
    return alt === null
      ? [general]
      : [general, { role: 'core', text: shape.canonical, lang: alt, tags: 'general' }];
  }
  const peakWord = lang === 'fr' ? 'mont' : 'mount';
  const expanded: PlannedQuery = {
    role: 'expanded',
    text: shape.hint === null ? `${peakWord} ${shape.core}` : shape.canonical,
    lang,
    tags: shape.hint === 'water' ? 'water' : 'peak',
  };
  const core: PlannedQuery = { role: 'core', text: shape.core, lang: alt ?? lang, tags: 'outdoor' };
  return [general, expanded, core];
}
