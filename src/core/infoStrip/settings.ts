/**
 * `settings.infoStrip`: the persisted strip (versioned, normalised).
 *
 * - A missing key means {@link DEFAULT_STRIP}, so a fresh install, an upgrade
 *   from 2.5.1 and an OTA rollback all read a valid state. A 2.5.1 user who
 *   had turned the centre chip and dot off (`showCenterCursor: false`) gets
 *   an empty strip with the cursor off: what they saw before.
 * - Every value is sanitised field by field back to its default.
 * - Field ids this build does not know (a newer build's) are KEPT, with their
 *   params, and skipped when drawn: rolling back and forward again loses
 *   nothing. Unknown params of known fields are kept the same way.
 *
 * The wiring into the settings store is the UI phase's.
 */
import { sanitizePointingLine } from '@core/map/pointingLineSettings';

import { normaliseParams, normaliseTarget } from './params';
import { CURSOR_COLORS, DEFAULT_CURSOR, DEFAULT_STRIP } from './presets';
import { fieldDescriptor } from './registry';
import { ROW_SPACES } from './layout';
import {
  MAX_ROWS,
  type CursorKind,
  type CursorSettings,
  type CursorSize,
  type Dock,
  type FieldRef,
  type InfoStrip,
  type MapAids,
} from './types';

export const INFO_STRIP_SCHEMA = 1;

/** The most saved strips kept ("Your strips"). */
export const MAX_SAVED_STRIPS = 50;
/** A strip name's longest form, characters. */
export const MAX_STRIP_NAME = 40;

export interface InfoStripSettings {
  schema: typeof INFO_STRIP_SCHEMA;
  /** The strip on the map. */
  current: InfoStrip;
  /** "Your strips": saved under the user's names. */
  saved: InfoStrip[];
}

/** What 2.5.1 persisted that the strip takes over. */
export interface LegacyStripSettings {
  /** 2.5.1's switch for the centre chip and dot together. */
  showCenterCursor?: boolean;
}

const DOCKS: readonly Dock[] = ['bottom', 'top'];
const CURSOR_KINDS: readonly CursorKind[] = ['dot', 'cross', 'reticle', 'ring', 'x'];
const CURSOR_SIZES: readonly CursorSize[] = ['S', 'M', 'L', 'XL'];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function oneOf<T>(list: readonly T[], value: unknown, fallback: T): T {
  return list.includes(value as T) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function cloneDefault(): InfoStrip {
  return JSON.parse(JSON.stringify(DEFAULT_STRIP)) as InfoStrip;
}

export function normaliseCursor(raw: unknown): CursorSettings {
  if (!isObject(raw)) return { ...DEFAULT_CURSOR };
  const d = DEFAULT_CURSOR;
  const color =
    typeof raw.color === 'string'
      ? CURSOR_COLORS.find((c) => c.hex.toLowerCase() === (raw.color as string).toLowerCase())?.hex
      : undefined;
  return {
    enabled: bool(raw.enabled, d.enabled),
    kind: oneOf(CURSOR_KINDS, raw.kind, d.kind),
    size: oneOf(CURSOR_SIZES, raw.size, d.size),
    color: color ?? d.color,
    halo: bool(raw.halo, d.halo),
    hideWhileFollowing: bool(raw.hideWhileFollowing, d.hideWhileFollowing),
  };
}

function normaliseAids(raw: unknown): MapAids {
  const r = isObject(raw) ? raw : {};
  const aids: MapAids = { cursor: normaliseCursor(r.cursor) };
  if (r.pointingLine !== undefined) aids.pointingLine = sanitizePointingLine(r.pointingLine);
  return aids;
}

/**
 * One row: known fields with their params normalised, unknown ones kept as
 * they are; a known field that no longer fits the row's spaces is dropped.
 */
function normaliseRow(raw: unknown): FieldRef[] {
  if (!Array.isArray(raw)) return [];
  const out: FieldRef[] = [];
  let used = 0;
  for (const item of raw) {
    if (!isObject(item) || typeof item.field !== 'string') continue;
    const d = fieldDescriptor(item.field);
    if (d === undefined) {
      out.push({ field: item.field, params: isObject(item.params) ? { ...item.params } : {} });
      continue;
    }
    if (used + d.spaces > ROW_SPACES) continue;
    used += d.spaces;
    out.push({ field: item.field, params: normaliseParams(d.params, d.defaults, item.params) });
  }
  return out;
}

/** A persisted strip, or null when it is not one at all. */
export function normaliseStrip(raw: unknown): InfoStrip | null {
  if (!isObject(raw)) return null;
  const rows = Array.isArray(raw.rows)
    ? raw.rows
        .map(normaliseRow)
        .filter((r) => r.length > 0)
        .slice(0, MAX_ROWS)
    : [];
  const name =
    typeof raw.name === 'string' && raw.name.trim() !== ''
      ? raw.name.trim().slice(0, MAX_STRIP_NAME)
      : DEFAULT_STRIP.name;
  const strip: InfoStrip = {
    name,
    dock: oneOf(DOCKS, raw.dock, DEFAULT_STRIP.dock),
    rows,
    aids: normaliseAids(raw.aids),
    target: normaliseTarget(raw.target) ?? { kind: 'navTarget' },
  };
  if (typeof raw.basedOn === 'string' && raw.basedOn !== '') strip.basedOn = raw.basedOn;
  return strip;
}

/** The state for a missing key: the default strip, or 2.5.1's "off" carried over. */
function fromLegacy(legacy: LegacyStripSettings): InfoStrip {
  const s = cloneDefault();
  if (legacy.showCenterCursor === false) {
    s.rows = [];
    s.aids.cursor.enabled = false;
  }
  return s;
}

/** `settings.infoStrip` as read from disk → a valid state (see the module note). */
export function normaliseInfoStripSettings(
  raw: unknown,
  legacy: LegacyStripSettings = {},
): InfoStripSettings {
  if (!isObject(raw)) return { schema: INFO_STRIP_SCHEMA, current: fromLegacy(legacy), saved: [] };
  const saved = Array.isArray(raw.saved)
    ? raw.saved
        .map(normaliseStrip)
        .filter((s): s is InfoStrip => s !== null)
        .slice(0, MAX_SAVED_STRIPS)
    : [];
  return {
    schema: INFO_STRIP_SCHEMA,
    current: normaliseStrip(raw.current) ?? fromLegacy(legacy),
    saved,
  };
}
