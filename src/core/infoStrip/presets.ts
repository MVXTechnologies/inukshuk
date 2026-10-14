/**
 * The default strip and the built-in presets (mockup 2.6.0 info strip §6).
 *
 * `DEFAULT_STRIP` is 2.5.1's bottom row re-homed: one row of the map
 * centre's coordinates and the ground elevation there, plus the dot cursor.
 * A preset carries its map aids too: Survey turns on the crosshair and the
 * pointing line. A preset whose fields need an extension that is not
 * installed applies anyway, without those fields (owner: never greyed out).
 */
import type { AnyExtensionKey } from '@core/extensions/keys';
import { DEFAULT_POINTING_LINE } from '@core/map/pointingLineSettings';

import { fieldDescriptor, fieldAvailable, type FieldId } from './registry';
import type { CursorSettings, FieldRef, InfoStrip, Params } from './types';

/** The cursor colours (mockup §7): stone first, then paper, then the pin palette. */
export const CURSOR_COLORS: readonly { hex: string; name: string }[] = [
  { hex: '#1E252C', name: 'Stone' },
  { hex: '#FBF8F2', name: 'Paper' },
  { hex: '#D32F2F', name: 'Red' },
  { hex: '#E8612C', name: 'Orange' },
  { hex: '#F2A900', name: 'Amber' },
  { hex: '#43A047', name: 'Green' },
  { hex: '#1E64C8', name: 'Blue' },
  { hex: '#7E57C2', name: 'Purple' },
  { hex: '#C2185B', name: 'Magenta' },
];

/** 2.5.1's centre dot: small, stone, paper halo, hidden while the map follows you. */
export const DEFAULT_CURSOR: CursorSettings = {
  enabled: true,
  kind: 'dot',
  size: 'S',
  color: '#1E252C',
  halo: true,
  hideWhileFollowing: true,
};

/** A field ref with its descriptor's defaults, overridden by `params`. */
export function ref(field: FieldId, params: Params = {}): FieldRef {
  return { field, params: { ...fieldDescriptor(field)!.defaults, ...params } };
}

/** 2.5.1's chip and dot as a strip: centre coordinates (in the Settings format) + elevation. */
export const DEFAULT_STRIP: InfoStrip = {
  name: 'Default',
  basedOn: 'default',
  dock: 'bottom',
  rows: [[ref('coords'), ref('elevation')]],
  aids: { cursor: DEFAULT_CURSOR },
  target: { kind: 'navTarget' },
};

export type PresetId = 'default' | 'hiking' | 'navigation' | 'survey' | 'paddling';

export interface Preset {
  id: PresetId;
  name: string;
  /** The card's one-liner. */
  summary: string;
  /** The card's map-aid line ("Crosshair · pointing line 500 m, ticks 100 m"). */
  aidsSummary: string;
  strip: InfoStrip;
}

const strip = (
  id: PresetId,
  name: string,
  rows: FieldRef[][],
  more: Partial<InfoStrip> = {},
): InfoStrip => ({
  name,
  basedOn: id,
  dock: 'bottom',
  rows,
  aids: { cursor: DEFAULT_CURSOR },
  target: { kind: 'navTarget' },
  ...more,
});

/** The five built-in strips, in the Presets page's order. */
export const PRESETS: readonly Preset[] = [
  {
    id: 'default',
    name: 'Default',
    summary: 'Coordinates and elevation',
    aidsSummary: 'Dot cursor',
    strip: DEFAULT_STRIP,
  },
  {
    id: 'hiking',
    name: 'Hiking',
    summary: 'Next on trail, time to it, altitude, sunset',
    aidsSummary: 'Dot cursor',
    strip: strip(
      'hiking',
      'Hiking',
      [
        [ref('targetName'), ref('targetDistance'), ref('ete'), ref('offTrail')],
        [ref('altitude'), ref('speed'), ref('sunset')],
      ],
      { target: { kind: 'nextOnTrail' } },
    ),
  },
  {
    id: 'navigation',
    name: 'Navigation',
    summary: 'Target, bearing, ETE/ETA, heading, declination',
    aidsSummary: 'Dot cursor',
    strip: strip('navigation', 'Navigation', [
      [ref('targetName'), ref('targetDistance'), ref('targetBearing'), ref('ete')],
      [ref('speed'), ref('heading'), ref('eta'), ref('declination')],
      [ref('coords'), ref('elevation')],
    ]),
  },
  {
    id: 'survey',
    name: 'Survey',
    summary: 'Your position and accuracy, GNSS, a mark',
    aidsSummary: 'Crosshair · pointing line 500 m, ticks 100 m',
    strip: strip(
      'survey',
      'Survey',
      [
        [ref('coords', { point: 'you', format: 'ddm' }), ref('accuracy')],
        [ref('gnss:height'), ref('gnss:fix'), ref('declination')],
        [ref('targetName'), ref('targetDistance'), ref('targetBearing')],
      ],
      {
        aids: {
          cursor: { ...DEFAULT_CURSOR, kind: 'cross', size: 'M' },
          pointingLine: {
            ...DEFAULT_POINTING_LINE,
            enabled: true,
            length: 500,
            ticks: 100,
            labelEvery5th: true,
          },
        },
      },
    ),
  },
  {
    id: 'paddling',
    name: 'Paddling',
    summary: 'Speed and course over water, tide',
    aidsSummary: 'Dot cursor',
    strip: strip('paddling', 'Paddling', [
      [
        ref('speed', { style: 'sog' }),
        ref('heading', { source: 'course' }),
        ref('targetName'),
        ref('targetDistance', { unit: 'nmi' }),
      ],
      [ref('tides:level'), ref('tides:nextHigh'), ref('eta')],
    ]),
  },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** The extensions a strip's fields need that are not installed ("Needs Tide stations · Get"). */
export function missingExtensions(
  s: InfoStrip,
  installed: ReadonlySet<AnyExtensionKey>,
): AnyExtensionKey[] {
  const out = new Set<AnyExtensionKey>();
  for (const row of s.rows) {
    for (const f of row) {
      const req = fieldDescriptor(f.field)?.requires;
      if (req !== undefined && !installed.has(req)) out.add(req);
    }
  }
  return [...out];
}

/**
 * Apply a preset: its strip, minus the fields whose extension is not
 * installed; a row left empty goes and the rest re-fit. The result is a
 * fresh copy, safe to edit.
 */
export function applyPreset(p: Preset, installed: ReadonlySet<AnyExtensionKey>): InfoStrip {
  const copy = JSON.parse(JSON.stringify(p.strip)) as InfoStrip;
  copy.rows = copy.rows
    .map((row) =>
      row.filter((f) => {
        const d = fieldDescriptor(f.field);
        return d !== undefined && fieldAvailable(d, installed);
      }),
    )
    .filter((row) => row.length > 0);
  return copy;
}

/**
 * Whether a strip still matches the preset it was based on, as that preset
 * applies now (for the "· edited" suffix). A strip based on no preset is
 * never "edited": it is the user's own.
 */
export function isEditedPreset(s: InfoStrip, installed: ReadonlySet<AnyExtensionKey>): boolean {
  const p = s.basedOn === undefined ? undefined : presetById(s.basedOn);
  if (p === undefined) return false;
  const a = applyPreset(p, installed);
  return (
    canonical([s.dock, s.rows, s.aids, s.target]) !== canonical([a.dock, a.rows, a.aids, a.target])
  );
}

/** JSON with object keys sorted, so key order never counts as an edit. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val !== null && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : val,
  );
}
