/**
 * Climbing grades in the user's system (owner decision Q5-A: YDS in North
 * America, French elsewhere, switchable in Settings).
 *
 * The tiles and topos carry system-neutral difficulty: one integer ladder per
 * discipline, shared with the NAS build (`infra/tiles/nas/climbing/grades.py`
 * — keep both in step):
 *
 * - rope ('r'): the YDS fine scale. 0–9 = 5.0–5.9, then four steps per
 *   number: 10 = 5.10a … 33 = 5.15d. French maps onto it through OpenBeta's
 *   own export (5.10a ↔ 6a, 5.11d ↔ 7a, 5.13b ↔ 8a).
 * - boulder ('b'): V scale, −1 = VB … 17 = V17; Font for French users.
 * - ice ('i'): WI1–WI8, the same everywhere.
 *
 * A route keeps its source's own string (`g`, system `gs`): when that is the
 * user's system it is shown verbatim ("5.10a/b"), else converted from the
 * ladder, and the card says where it came from ("UIAA 7- in OSM").
 */

export type GradeSystem = 'yds' | 'french';
export type GradeKind = 'r' | 'b' | 'i';
/** Band index on the four-colour bar: easy, mid, hard, elite. */
export type Band = 0 | 1 | 2 | 3;

export const ROPE_YDS: readonly string[] = [
  '5.0',
  '5.1',
  '5.2',
  '5.3',
  '5.4',
  '5.5',
  '5.6',
  '5.7',
  '5.8',
  '5.9',
  ...[10, 11, 12, 13, 14, 15].flatMap((n) => ['a', 'b', 'c', 'd'].map((l) => `5.${n}${l}`)),
];

export const ROPE_FRENCH: readonly string[] = [
  '2-',
  '2',
  '3',
  '3+',
  '4a',
  '4b',
  '4c',
  '5a',
  '5b',
  '5c',
  '6a',
  '6a+',
  '6b',
  '6b+',
  '6c',
  '6c',
  '6c+',
  '7a',
  '7a+',
  '7b',
  '7b+',
  '7c',
  '7c+',
  '8a',
  '8a+',
  '8b',
  '8b+',
  '8c',
  '8c+',
  '9a',
  '9a+',
  '9b',
  '9b+',
  '9c',
];

/** Font per V index (V0 = '4'); VB is '3'. */
const FONT: readonly string[] = [
  '4',
  '5',
  '5+',
  '6a',
  '6b',
  '6c',
  '7a',
  '7a+',
  '7b',
  '7c',
  '7c+',
  '8a',
  '8a+',
  '8b',
  '8b+',
  '8c',
  '8c+',
  '9a',
];

const SYSTEM_NAMES: Record<string, string> = {
  yds: 'YDS',
  french: 'French',
  uiaa: 'UIAA',
  v: 'V',
  font: 'Font',
  wi: 'WI',
  saxon: 'Saxon',
  nordic: 'Nordic',
  british: 'British',
};

/** A ladder index as text in the user's system; null when out of range. */
export function gradeLabel(kind: GradeKind, index: number, system: GradeSystem): string | null {
  if (!Number.isInteger(index)) return null;
  if (kind === 'r') {
    const table = system === 'yds' ? ROPE_YDS : ROPE_FRENCH;
    return table[index] ?? null;
  }
  if (kind === 'b') {
    if (index === -1) return system === 'yds' ? 'VB' : '3';
    if (index < 0 || index > 17) return null;
    return system === 'yds' ? `V${index}` : (FONT[index] ?? null);
  }
  return index >= 1 && index <= 8 ? `WI${index}` : null;
}

/** Whether a source system is the one the user reads (so its string shows verbatim). */
function sameSystem(source: string | undefined, kind: GradeKind, user: GradeSystem): boolean {
  if (source === undefined) return false;
  if (kind === 'r') return source === user;
  if (kind === 'b') return user === 'yds' ? source === 'v' : source === 'font';
  return source === 'wi';
}

export interface GradedRoute {
  /** The source's own grade string, and its system. */
  g?: string;
  gs?: string;
  /** The ladder: discipline and index (absent when the grade didn't parse). */
  k?: GradeKind;
  x?: number;
}

export interface RouteGrade {
  /** What the pill shows. */
  text: string;
  band: Band | null;
  /** "UIAA 7- in OSM" when converted, else null. */
  note: string | null;
}

/**
 * A route's grade for display: the source string when it is in the user's
 * system, else converted from the ladder (with a note), else the source
 * string as is (a system we can't place, like Saxon).
 */
export function routeGrade(
  route: GradedRoute,
  system: GradeSystem,
  sourceName?: string,
): RouteGrade | null {
  const band = route.k !== undefined && route.x !== undefined ? bandOf(route.k, route.x) : null;
  if (route.k !== undefined && route.x !== undefined) {
    if (route.g !== undefined && sameSystem(route.gs, route.k, system)) {
      return { text: route.g, band, note: null };
    }
    const text = gradeLabel(route.k, route.x, system);
    if (text !== null) {
      const note =
        route.g !== undefined && route.gs !== undefined && route.gs !== 'wi'
          ? `${SYSTEM_NAMES[route.gs] ?? route.gs} ${route.g}${sourceName ? ` in ${sourceName}` : ''}`
          : null;
      return { text, band, note };
    }
  }
  if (route.g !== undefined) {
    const name = route.gs !== undefined ? SYSTEM_NAMES[route.gs] : undefined;
    return { text: route.g, band: null, note: name !== undefined ? `${name} grade` : null };
  }
  return null;
}

export function bandOf(kind: GradeKind, index: number): Band {
  if (kind === 'r') return index <= 7 ? 0 : index <= 13 ? 1 : index <= 17 ? 2 : 3;
  if (kind === 'b') return index <= 2 ? 0 : index <= 5 ? 1 : index <= 8 ? 2 : 3;
  return index <= 3 ? 0 : index === 4 ? 1 : index === 5 ? 2 : 3;
}

/** The four bands' labels for rope routes ("≤ 5.7", "5.8–5.10", "5.11", "5.12+"). */
export function bandLabels(system: GradeSystem): [string, string, string, string] {
  return system === 'yds'
    ? ['≤ 5.7', '5.8–5.10', '5.11', '5.12+']
    : ['≤ 5a', '5b–6b+', '6c–7a', '7a+ and up'];
}

/** "5.4 – 5.13a" for a ladder range; a single grade when min = max. */
export function gradeRangeLabel(
  kind: GradeKind,
  range: readonly [number, number],
  system: GradeSystem,
): string | null {
  const lo = gradeLabel(kind, range[0], system);
  const hi = gradeLabel(kind, range[1], system);
  if (lo === null || hi === null) return lo ?? hi;
  return lo === hi ? lo : `${lo} – ${hi}`;
}

/**
 * The user's system when Settings says "Automatic": YDS in North America
 * (by the last known position, else the device's region), French elsewhere.
 */
export function autoGradeSystem(
  position: { latitude: number; longitude: number } | null,
  region?: string | null,
): GradeSystem {
  if (position !== null) {
    const { latitude: lat, longitude: lng } = position;
    const northAmerica = lat >= 14 && lat <= 84 && lng >= -170 && lng <= -50;
    return northAmerica ? 'yds' : 'french';
  }
  return region === 'US' || region === 'CA' || region === 'MX' ? 'yds' : 'french';
}

export function resolveGradeSystem(
  setting: 'auto' | GradeSystem,
  position: { latitude: number; longitude: number } | null,
  region?: string | null,
): GradeSystem {
  return setting === 'auto' ? autoGradeSystem(position, region) : setting;
}
