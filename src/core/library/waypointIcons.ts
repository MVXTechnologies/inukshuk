import type { WaypointIcon } from '@core/models';

/**
 * The waypoint pin icon catalogue (#350) — one table owning all three faces of
 * an icon: the name the user picks it by, the MaterialCommunityIcons glyph the
 * UI draws (`@expo/vector-icons`, already bundled — no new asset pipeline), and
 * the GPX `<sym>` value it is written as.
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

/** Everything the app knows about one pickable icon, minus its id. */
interface WaypointIconDetail {
  /** Short name shown under the picker tile and read by screen readers. */
  label: string;
  /** MaterialCommunityIcons glyph name. */
  glyph: string;
  /** Value written to `<sym>` on GPX export. */
  sym: string;
  /**
   * Extra `<sym>` spellings accepted on import, lower-cased. Other apps are
   * not consistent (Garmin writes "Campground", OsmAnd "tourism_camp_site", a
   * hand-written file just "camp"), so read tolerantly and write exactly one
   * canonical value.
   */
  symAliases?: readonly string[];
}

export interface WaypointIconSpec extends WaypointIconDetail {
  id: WaypointIcon;
}

/**
 * The catalogue. A `Record` keyed by the model's union, so adding an icon to
 * `WaypointIcon` without describing it here is a type error rather than a pin
 * that silently falls back to the default.
 */
const DETAILS: Record<WaypointIcon, WaypointIconDetail> = {
  camp: {
    label: 'Camp',
    glyph: 'tent',
    sym: 'Campground',
    symAliases: ['camp', 'campsite', 'camp site', 'tent', 'tourism_camp_site'],
  },
  shelter: {
    label: 'Shelter',
    glyph: 'cabin-a-frame',
    sym: 'Lodging',
    symAliases: ['shelter', 'hut', 'cabin', 'lodge', 'refuge', 'bivouac'],
  },
  water: {
    label: 'Water',
    glyph: 'water',
    sym: 'Drinking Water',
    symAliases: ['water', 'water source', 'spring', 'potable water'],
  },
  food: {
    label: 'Food',
    glyph: 'silverware-fork-knife',
    sym: 'Restaurant',
    symAliases: ['food', 'fast food', 'cafe', 'bar'],
  },
  trailhead: {
    label: 'Trailhead',
    glyph: 'hiking',
    sym: 'Trail Head',
    symAliases: ['trailhead', 'trail', 'trailhead parking'],
  },
  parking: {
    label: 'Parking',
    glyph: 'parking',
    sym: 'Parking Area',
    symAliases: ['parking', 'car park', 'parking lot'],
  },
  summit: {
    label: 'Summit',
    glyph: 'summit',
    sym: 'Summit',
    symAliases: ['peak', 'mountain', 'mountain top', 'sommet'],
  },
  viewpoint: {
    label: 'Viewpoint',
    glyph: 'binoculars',
    sym: 'Scenic Area',
    symAliases: ['viewpoint', 'scenic', 'overlook', 'lookout', 'belvedere'],
  },
  ford: {
    label: 'Ford',
    glyph: 'waves-arrow-right',
    sym: 'Ford',
    symAliases: ['crossing', 'river crossing', 'stream crossing'],
  },
  gate: {
    label: 'Gate',
    glyph: 'gate',
    sym: 'Gate',
    symAliases: ['barrier', 'fence gate'],
  },
  cache: {
    label: 'Cache',
    glyph: 'treasure-chest',
    sym: 'Geocache',
    symAliases: ['cache', 'geocache found', 'food cache', 'stash'],
  },
  hazard: {
    label: 'Hazard',
    glyph: 'alert-outline',
    sym: 'Danger Area',
    symAliases: ['hazard', 'danger', 'caution', 'warning', 'skull and crossbones'],
  },
};

/**
 * Picker order: shelter and supply first (the things a day is planned around),
 * then the navigational marks, then the warnings.
 *
 * Deliberately a dozen. A grid you can take in at a glance with cold hands
 * beats an exhaustive symbol library — and a symbol absent from this table is
 * not lost on import, it simply falls back to the default pin.
 */
const ORDER: readonly WaypointIcon[] = [
  'camp',
  'shelter',
  'water',
  'food',
  'trailhead',
  'parking',
  'summit',
  'viewpoint',
  'ford',
  'gate',
  'cache',
  'hazard',
];

/** The pickable icons, in picker order. */
export const WAYPOINT_ICONS: readonly WaypointIconSpec[] = ORDER.map((id) => ({
  id,
  ...DETAILS[id],
}));

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
for (const spec of WAYPOINT_ICONS) {
  BY_SYM.set(normalizeSym(spec.sym), spec.id);
  // The id itself is a legitimate spelling, and accepting it costs nothing.
  BY_SYM.set(normalizeSym(spec.id), spec.id);
  for (const alias of spec.symAliases ?? []) BY_SYM.set(normalizeSym(alias), spec.id);
}

/** Whether a persisted (or foreign) value names an icon this build knows. */
export function isWaypointIcon(value: unknown): value is WaypointIcon {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DETAILS, value);
}

/**
 * The catalogue row for an icon, or `null` for the default pin — including for
 * an icon id a future build knows and this one does not, which is exactly the
 * downgrade case the library migration tolerates rather than rejects.
 */
export function waypointIconSpec(icon: WaypointIcon | undefined): WaypointIconSpec | null {
  return icon !== undefined && isWaypointIcon(icon) ? { id: icon, ...DETAILS[icon] } : null;
}

/** Glyph to draw for a waypoint, or `null` when it uses the default pin. */
export function waypointIconGlyph(icon: WaypointIcon | undefined): string | null {
  return waypointIconSpec(icon)?.glyph ?? null;
}

/** Human name of a waypoint's icon, for screen readers and list rows. */
export function waypointIconLabel(icon: WaypointIcon | undefined): string {
  return waypointIconSpec(icon)?.label ?? DEFAULT_WAYPOINT_ICON_LABEL;
}

/**
 * GPX `<sym>` for a waypoint's icon — `undefined` for a waypoint with no icon,
 * so the exported `<wpt>` simply carries no `<sym>` rather than an invented one.
 */
export function gpxSymForWaypointIcon(icon: WaypointIcon | undefined): string | undefined {
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
