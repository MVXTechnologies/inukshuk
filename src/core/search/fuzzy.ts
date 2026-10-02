import { foldForSearch } from '@core/library/searchTracks';

/**
 * Forgiving name matching for place search (#496 feedback: "katadhin mount"
 * has to find Mount Katahdin).
 *
 * - **Folded:** accents, case and separators do not matter ("Mont-Sainte-Anne"
 *   is "mont sainte anne").
 * - **Token order does not matter:** "katahdin mount" matches "Mount Katahdin".
 * - **Generic words are optional:** mount/mt/mont/monte/mountain/pic/pico/peak
 *   are one "peak" word and lac/lake/étang/pond/lago one "water" word. A name
 *   still matches without the generic word the user typed, and the user need
 *   not type the one in the name ("katahdin" → "Mount Katahdin").
 * - **Abbreviations:** st/ste/saint/sainte (and san/santa/sankt) are one word.
 * - **Small typos:** a Damerau–Levenshtein distance (transpositions count as
 *   one edit) of 1 for 5–8 letter words and 2 from 9 letters on: "katadhin" →
 *   "Katahdin", "matterhron" → "Matterhorn". Words of 4 letters or fewer must
 *   be exact (or the start of the name's word): too many names are one edit
 *   apart there.
 * - **Typing in progress:** a word may be the start of the name's word
 *   ("mont sainte an"), typos allowed there too ("katadh" → "Katahdin").
 *
 * Pure: the Worker has its own small copy of the generic-word table
 * (`infra/tiles/worker/src/searchPlan.ts`) to plan its upstream queries.
 */

/** What a generic word says about the place. */
export type GenericHint = 'peak' | 'water';

const PEAK_WORDS = [
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
];
const WATER_WORDS = ['lac', 'lake', 'etang', 'pond', 'lago', 'loch'];
const SAINT_WORDS = ['st', 'ste', 'saint', 'sainte', 'san', 'santa', 'sankt'];
/** Words that never decide a match ("Lac des Neiges", "Mount of the Holy Cross"). */
const STOP_WORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'of', 'the', 'a']);

const CANONICAL = new Map<string, string>([
  ...PEAK_WORDS.map((w): [string, string] => [w, '<peak>']),
  ...WATER_WORDS.map((w): [string, string] => [w, '<water>']),
  ...SAINT_WORDS.map((w): [string, string] => [w, 'saint']),
]);

const isGeneric = (t: string) => t === '<peak>' || t === '<water>';

/** One folded word in its canonical form (generic words and saints collapsed). */
export function canonicalToken(token: string): string {
  return CANONICAL.get(token) ?? token;
}

/** The canonical words of a name or query, stop words dropped. */
export function canonicalTokens(text: string): string[] {
  const folded = foldForSearch(text);
  if (folded === '') return [];
  return folded
    .split(' ')
    .filter((t) => !STOP_WORDS.has(t))
    .map(canonicalToken);
}

/** What a query is about: its distinctive words, and the generic word's hint. */
export interface QueryAnalysis {
  /** Distinctive words (generic words removed), canonical. */
  core: string[];
  /** The first generic word's kind, or null when the query has none. */
  hint: GenericHint | null;
  /** Every canonical word, in the typed order (for whole-name prefixes). */
  tokens: string[];
}

export function analyzeQuery(query: string): QueryAnalysis {
  const tokens = canonicalTokens(query);
  const generic = tokens.find(isGeneric);
  const core = tokens.filter((t) => !isGeneric(t));
  const hint = generic === '<peak>' ? 'peak' : generic === '<water>' ? 'water' : null;
  // "lake" alone: the generic word is all there is to match.
  return { core: core.length > 0 ? core : tokens, hint, tokens };
}

/**
 * Optimal-string-alignment distance: Levenshtein plus adjacent
 * transpositions as one edit. Gives up (returns `max + 1`) once the distance
 * must exceed `max`.
 */
export function damerauLevenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  // Three rolling rows: two back (transpositions), previous, current.
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, (prev2[j - 2] ?? 0) + 1);
      }
      cur.push(d);
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length] ?? max + 1;
}

/** Typos allowed in a typed word of this length. */
export function allowedTypos(length: number): number {
  if (length <= 4) return 0;
  if (length <= 8) return 1;
  return 2;
}

/** Scores for one typed word against one name word. */
export const TOKEN_EXACT = 1;
export const TOKEN_PREFIX = 0.9;
const TOKEN_TYPO = [1, 0.8, 0.65];
const TOKEN_TYPO_PREFIX = [1, 0.75, 0.6];

/** How well a typed word matches a name word: 0 (not at all) … 1 (the same word). */
export function tokenScore(typed: string, word: string): number {
  if (typed === word) return TOKEN_EXACT;
  if (typed.length >= 2 && word.startsWith(typed)) return TOKEN_PREFIX;
  const max = allowedTypos(typed.length);
  if (max === 0) return 0;
  const d = damerauLevenshtein(typed, word, max);
  if (d <= max) return TOKEN_TYPO[d] ?? 0;
  // Still typing: compare with the start of the name's word.
  if (word.length > typed.length) {
    const dp = damerauLevenshtein(typed, word.slice(0, typed.length), max);
    if (dp <= max) return TOKEN_TYPO_PREFIX[dp] ?? 0;
  }
  return 0;
}

export interface NameMatch {
  /** 0 when some typed word matches nothing in the name; else ~0.5…1. */
  score: number;
  /**
   * Every distinctive word of the name was typed, each exactly or as a prefix
   * ("katahdin" for "Mount Katahdin", "mont sainte an" for
   * "Mont-Sainte-Anne"), or the query is the start of the whole name, in
   * order ("chamonix" for "Chamonix-Mont-Blanc"). Typos are never strong.
   */
  strong: boolean;
}

const NO_MATCH: NameMatch = { score: 0, strong: false };

/**
 * Match a query against one name. Every distinctive word of the query must
 * match a different word of the name (in any order); the score is their
 * average, discounted when the name has words the query did not cover
 * ("Katahdin Lake Trail" is a weaker answer to "katahdin" than "Katahdin
 * Lake"). Generic words are matched when both sides have them and otherwise
 * ignored, with a small discount when the user typed one the name lacks.
 */
export function matchName(name: string, query: string | QueryAnalysis): NameMatch {
  const q = typeof query === 'string' ? analyzeQuery(query) : query;
  if (q.core.length === 0) return NO_MATCH;
  const all = canonicalTokens(name);
  const words = all.filter((t) => !isGeneric(t));
  // A name of only generic words ("Lake"): match against those.
  const pool = words.length > 0 && !q.core.every(isGeneric) ? words : all;
  const used = new Set<number>();
  let sum = 0;
  let allStrong = true;
  for (const typed of q.core) {
    let best = 0;
    let bestAt = -1;
    pool.forEach((word, i) => {
      if (used.has(i)) return;
      const s = tokenScore(typed, word);
      if (s > best) {
        best = s;
        bestAt = i;
      }
    });
    if (bestAt < 0) return NO_MATCH;
    used.add(bestAt);
    sum += best;
    if (best < TOKEN_PREFIX) allStrong = false;
  }
  const coverage = used.size / pool.length;
  let score = (sum / q.core.length) * (0.75 + 0.25 * coverage);
  const hintWord = q.hint === null ? null : `<${q.hint}>`;
  if (hintWord !== null && !all.includes(hintWord)) score *= 0.95;
  return { score, strong: allStrong && (coverage === 1 || startsName(all, q.tokens)) };
}

/** The typed words are the name's first words, in order (the last may be cut short). */
function startsName(name: readonly string[], typed: readonly string[]): boolean {
  if (typed.length === 0 || typed.length > name.length) return false;
  return typed.every((t, i) => {
    const w = name[i] ?? '';
    return i === typed.length - 1 ? w.startsWith(t) : w === t;
  });
}
