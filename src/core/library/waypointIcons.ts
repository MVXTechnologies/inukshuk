import type { WaypointIcon } from '@core/models';

import { WAYPOINT_ICON_GROUPS, type WaypointIconGroupId } from './waypointIconCatalog';

/**
 * The waypoint pin icon catalogue (#350, widened to ~350 icons by #675) — one
 * table owning every face of an icon: the name the user picks it by, the
 * MaterialCommunityIcons glyph the UI draws (`@expo/vector-icons`, already
 * bundled), the picker group, the search keywords, and the GPX `<sym>` value
 * it is written as. The rows themselves are in `./waypointIconCatalog`.
 *
 * Keeping the glyph and the `<sym>` in the SAME row is deliberate: a second
 * table would drift, and an exported `<sym>` we cannot read back is worse than
 * no `<sym>` at all.
 *
 * Pure: no `react-native` / `expo` imports. The glyph is typed as a plain
 * `string` here for that reason; the one place that feeds it to
 * `MaterialCommunityIcons` narrows it, and `waypointGlyphs.test.ts` asserts
 * every glyph in this table really exists in the shipped font.
 */

/** Everything the app knows about one pickable icon. */
export interface WaypointIconSpec {
  id: WaypointIcon;
  /** Short name shown under the picker tile and read by screen readers. */
  label: string;
  /** MaterialCommunityIcons glyph name. */
  glyph: string;
  /** Value written to `<sym>` on GPX export. */
  sym: string;
  /**
   * Extra `<sym>` spellings accepted on import. Other apps are not consistent
   * (Garmin writes "Campground", OsmAnd "tourism_camp_site", a hand-written
   * file just "camp"), so read tolerantly and write exactly one canonical value.
   */
  symAliases?: readonly string[];
  /** The picker group it is listed under. */
  group: WaypointIconGroupId;
  /** Search synonyms (English, then French), as written in the catalogue. */
  keywords: readonly string[];
}

/**
 * The twelve #350 icons keep the Garmin-style `<sym>` they have always been
 * exported with, and their import aliases. Every newer icon writes its label.
 */
const LEGACY_SYM: Readonly<Record<string, { sym: string; symAliases: readonly string[] }>> = {
  camp: {
    sym: 'Campground',
    symAliases: ['camp', 'campsite', 'camp site', 'tent', 'tourism_camp_site'],
  },
  shelter: {
    sym: 'Lodging',
    symAliases: ['shelter', 'hut', 'cabin', 'lodge', 'refuge', 'bivouac'],
  },
  water: {
    sym: 'Drinking Water',
    symAliases: ['water', 'water source', 'spring', 'potable water'],
  },
  food: { sym: 'Restaurant', symAliases: ['food', 'fast food', 'cafe', 'bar'] },
  trailhead: { sym: 'Trail Head', symAliases: ['trailhead', 'trail', 'trailhead parking'] },
  parking: { sym: 'Parking Area', symAliases: ['parking', 'car park', 'parking lot'] },
  summit: { sym: 'Summit', symAliases: ['peak', 'mountain', 'mountain top', 'sommet'] },
  viewpoint: {
    sym: 'Scenic Area',
    symAliases: ['viewpoint', 'scenic', 'overlook', 'lookout', 'belvedere'],
  },
  ford: { sym: 'Ford', symAliases: ['crossing', 'river crossing', 'stream crossing'] },
  gate: { sym: 'Gate', symAliases: ['barrier', 'fence gate'] },
  cache: { sym: 'Geocache', symAliases: ['cache', 'geocache found', 'food cache', 'stash'] },
  hazard: {
    sym: 'Danger Area',
    symAliases: ['hazard', 'danger', 'caution', 'warning', 'skull and crossbones'],
  },
};

/**
 * Newer icons whose label is already a #350 spelling (Garmin's vocabulary
 * overlaps): they write a `<sym>` of their own so a `<sym>`-only reader can
 * still tell them apart.
 */
const SYM_OVERRIDE: Readonly<Record<string, string>> = {
  spring: 'Natural Spring',
  potable: 'Water Refill',
  mountain: 'Mountain Range',
  lookout: 'Lookout Point',
  danger: 'Extreme Danger',
};

/** One picker group, with its icons resolved. */
export interface WaypointIconGroup {
  id: WaypointIconGroupId;
  /** Section heading in the picker. */
  label: string;
  /** Short name for the picker's jump chip. */
  chip: string;
  icons: readonly WaypointIconSpec[];
}

const splitKeywords = (text: string): string[] =>
  text
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '');

/** The picker's groups, in catalogue order. */
export const WAYPOINT_ICON_GROUP_LIST: readonly WaypointIconGroup[] = WAYPOINT_ICON_GROUPS.map(
  (group) => ({
    id: group.id,
    label: group.label,
    chip: group.chip,
    icons: group.icons.map(([id, label, glyph, keywords]): WaypointIconSpec => {
      const legacy = LEGACY_SYM[id];
      return {
        id,
        label,
        glyph,
        sym: legacy?.sym ?? SYM_OVERRIDE[id] ?? label,
        ...(legacy ? { symAliases: legacy.symAliases } : {}),
        group: group.id,
        keywords: splitKeywords(keywords),
      };
    }),
  }),
);

/** Every pickable icon, in picker order. */
export const WAYPOINT_ICONS: readonly WaypointIconSpec[] = WAYPOINT_ICON_GROUP_LIST.flatMap(
  (g) => g.icons,
);

const BY_ID = new Map<string, WaypointIconSpec>(WAYPOINT_ICONS.map((s) => [s.id, s]));

/** Label of the "no icon" choice — today's inukshuk pin. */
export const DEFAULT_WAYPOINT_ICON_LABEL = 'Default pin';

/**
 * `<sym>` (and alias) lookup key: lower-cased, with runs of whitespace, `_`
 * and `-` collapsed to one space. That single rule is what makes "Trail Head",
 * "trail_head" and "TRAILHEAD" — all of which occur in real files — land on
 * the same icon.
 */
const normalizeSym = (sym: string): string =>
  sym
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');

const BY_SYM = new Map<string, WaypointIcon>();
// The #350 spellings first: they were promised before the catalogue grew, so
// a newer icon's label or id can never steal one ("spring", "tent", "cabin").
for (const spec of WAYPOINT_ICONS) {
  const legacy = LEGACY_SYM[spec.id];
  if (!legacy) continue;
  BY_SYM.set(normalizeSym(legacy.sym), spec.id);
  BY_SYM.set(normalizeSym(spec.id), spec.id);
  for (const alias of legacy.symAliases) BY_SYM.set(normalizeSym(alias), spec.id);
}
for (const spec of WAYPOINT_ICONS) {
  for (const key of [spec.sym, spec.id]) {
    const k = normalizeSym(key);
    if (!BY_SYM.has(k)) BY_SYM.set(k, spec.id);
  }
}

/** Whether a persisted (or foreign) value names an icon this build knows. */
export function isWaypointIcon(value: unknown): value is WaypointIcon {
  return typeof value === 'string' && BY_ID.has(value);
}

/**
 * Whether a persisted value has the shape of an icon id (lowercase words
 * joined by hyphens, like every catalogue id) — known to this build or not.
 * A newer build's icon passes and is kept (it draws as the default pin here);
 * junk (non-strings, empty, capitals, spaces, overlong) does not.
 */
export function isStorableWaypointIconId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64
  );
}

/**
 * The catalogue row for an icon, or `null` for the default pin — including for
 * an icon id a future build knows and this one does not, which is exactly the
 * downgrade case the library migration tolerates rather than rejects.
 */
export function waypointIconSpec(icon: string | undefined): WaypointIconSpec | null {
  return icon === undefined ? null : (BY_ID.get(icon) ?? null);
}

/** Glyph to draw for a waypoint, or `null` when it uses the default pin. */
export function waypointIconGlyph(icon: string | undefined): string | null {
  return waypointIconSpec(icon)?.glyph ?? null;
}

/** Human name of a waypoint's icon, for screen readers and list rows. */
export function waypointIconLabel(icon: string | undefined): string {
  return waypointIconSpec(icon)?.label ?? DEFAULT_WAYPOINT_ICON_LABEL;
}

/**
 * GPX `<sym>` for a waypoint's icon — `undefined` for a waypoint with no icon,
 * so the exported `<wpt>` simply carries no `<sym>` rather than an invented one.
 */
export function gpxSymForWaypointIcon(icon: string | undefined): string | undefined {
  return waypointIconSpec(icon)?.sym;
}

/**
 * The icon a GPX `<sym>` names, or `undefined` when the file is silent or
 * names a symbol outside the catalogue (every Garmin symbol we do not draw).
 * Unknown is the DEFAULT PIN, never a failure: an import must not reject a
 * file over a decoration.
 */
export function waypointIconForGpxSym(sym: string | undefined | null): WaypointIcon | undefined {
  if (typeof sym !== 'string') return undefined;
  const key = normalizeSym(sym);
  return key === '' ? undefined : BY_SYM.get(key);
}

// ── Search ──────────────────────────────────────────────────────────────────

/** Case- and accent-folded text: "Belvédère" and "belvedere" compare equal. */
export function foldSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface SearchEntry {
  spec: WaypointIconSpec;
  label: string;
  /** Label, id and keywords, folded, each split into words. */
  words: readonly string[];
}

let searchIndex: readonly SearchEntry[] | null = null;
function index(): readonly SearchEntry[] {
  searchIndex ??= WAYPOINT_ICONS.map((spec) => {
    const phrases = [spec.label, spec.id.replace(/-/g, ' '), ...spec.keywords].map(foldSearchText);
    return {
      spec,
      label: foldSearchText(spec.label),
      words: phrases.flatMap((p) => p.split(/[\s,-]+/)).filter((w) => w !== ''),
    };
  });
  return searchIndex;
}

/**
 * Icons matching a typed query, best first: a label that starts with it, then
 * any name or synonym WORD that starts with it. Whole words and word prefixes
 * only, never the middle of a word: "tent" finds Camp (tent, tente), not
 * Hazard through "attention" (2.5.1 QA). Every word of a multi-word query
 * must match. Blank = no results (the picker shows its groups instead).
 * Order within a tier is catalogue order.
 */
export function searchWaypointIcons(query: string): WaypointIconSpec[] {
  const q = foldSearchText(query);
  if (q === '') return [];
  const terms = q.split(' ');
  const tiers: WaypointIconSpec[][] = [[], []];
  for (const entry of index()) {
    if (!terms.every((t) => entry.words.some((w) => w.startsWith(t)))) continue;
    tiers[entry.label.startsWith(q) ? 0 : 1]?.push(entry.spec);
  }
  return tiers.flat();
}
