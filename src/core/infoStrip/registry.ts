/**
 * The field registry: every info-strip field's descriptor, by id. The picker,
 * its search, the generated settings pages, the presets and the settings
 * normaliser all iterate this. Adding a field: a descriptor with a pure
 * `compute()` and its tests, and one line here.
 *
 * `satisfies`-checked like the extension registry, so a descriptor missing a
 * member fails the type check; `registry.test.ts` checks what types cannot
 * (unique ids, spaces, defaults that pass their own schema).
 */
import { foldText } from '@core/catalog/filterCatalog';
import type { AnyExtensionKey } from '@core/extensions/keys';

import { CURSOR_BEARING, CURSOR_DISTANCE } from './fields/cursor';
import { GNSS_FIX, GNSS_HEIGHT, TIDE_LEVEL, TIDE_NEXT_HIGH } from './fields/extensions';
import {
  ETA,
  ETE,
  OFF_TRAIL,
  TARGET_BEARING,
  TARGET_DISTANCE,
  TARGET_NAME,
} from './fields/navigation';
import { HEADING, SPEED, SUNSET } from './fields/motion';
import { ACCURACY, ALTITUDE, COORDS, DECLINATION, ELEVATION } from './fields/position';
import {
  HERO_DESCENT,
  HERO_DISTANCE,
  HERO_GAIN,
  HERO_MOVING,
  HERO_PACE,
  HERO_TIME,
} from './fields/recording';
import type { FieldDescriptor, FieldGroup } from './types';

/** Picker order within each group is registry order. */
export const FIELDS = {
  coords: COORDS,
  elevation: ELEVATION,
  altitude: ALTITUDE,
  accuracy: ACCURACY,
  declination: DECLINATION,
  targetName: TARGET_NAME,
  targetDistance: TARGET_DISTANCE,
  targetBearing: TARGET_BEARING,
  ete: ETE,
  eta: ETA,
  cursorBearing: CURSOR_BEARING,
  cursorDistance: CURSOR_DISTANCE,
  offTrail: OFF_TRAIL,
  speed: SPEED,
  heading: HEADING,
  sunset: SUNSET,
  'hero:time': HERO_TIME,
  'hero:distance': HERO_DISTANCE,
  'hero:gain': HERO_GAIN,
  'hero:descent': HERO_DESCENT,
  'hero:pace': HERO_PACE,
  'hero:moving': HERO_MOVING,
  'gnss:height': GNSS_HEIGHT,
  'gnss:fix': GNSS_FIX,
  'tides:level': TIDE_LEVEL,
  'tides:nextHigh': TIDE_NEXT_HIGH,
} satisfies Record<string, FieldDescriptor>;

export type FieldId = keyof typeof FIELDS;

export const FIELD_IDS = Object.keys(FIELDS) as FieldId[];

export function isFieldId(id: unknown): id is FieldId {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(FIELDS, id);
}

/** A field's descriptor, or undefined for an id this build does not know (a newer build's). */
export function fieldDescriptor(id: string): FieldDescriptor | undefined {
  return isFieldId(id) ? FIELDS[id] : undefined;
}

/** Picker groups, in order (mockup §3: All · Navigation · Position · Motion · Recording · Extensions). */
export const FIELD_GROUPS: readonly FieldGroup[] = [
  'navigation',
  'position',
  'motion',
  'recording',
  'extension',
];

/** Whether a field can show with these extensions installed. */
export function fieldAvailable(
  d: FieldDescriptor,
  installed: ReadonlySet<AnyExtensionKey>,
): boolean {
  return d.requires === undefined || installed.has(d.requires);
}

/**
 * The picker's list: the fields that are available, fit `freeSpaces`, and
 * match `query` (label, summary or a synonym, case- and accent-insensitive),
 * in registry order. Nothing is greyed out (the owner's sub-menu rule): what
 * does not fit is simply not listed.
 */
export function pickableFields(
  freeSpaces: number,
  installed: ReadonlySet<AnyExtensionKey>,
  query = '',
): FieldDescriptor[] {
  const q = foldText(query.trim());
  return FIELD_IDS.map((id) => FIELDS[id] as FieldDescriptor).filter(
    (d) =>
      d.spaces <= freeSpaces &&
      fieldAvailable(d, installed) &&
      (q === '' || [d.label, d.summary, ...d.synonyms].some((s) => foldText(s).includes(q))),
  );
}
