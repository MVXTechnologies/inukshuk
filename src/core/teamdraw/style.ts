import { isRecord } from '@core/team/canonical';

import type { PenStyle } from './pen';
import { COLOUR_COUNT, HEAD_TYPES, MAX_LIFE_MS, type HeadType } from './record';

/**
 * The drawing style (#683), set once and remembered on this phone (never
 * synced). It applies to the next shapes, never to ones already sent.
 * Colours are the eight member hues only, by index: no red, which stays
 * reserved for SOS.
 */
export const SECOND = 1_000;
export const FADE_CHOICES_MS: readonly (number | null)[] = [
  10 * SECOND,
  30 * SECOND,
  60 * SECOND,
  5 * 60 * SECOND,
  30 * 60 * SECOND,
  MAX_LIFE_MS,
  null,
];
/** Owner decision 2026-10-13: shapes fade after 30 s by default. */
export const DEFAULT_FADE_MS = 30 * SECOND;

export interface DrawPrefs {
  /** MEMBER_COLORS index. */
  colour: number;
  width: 1 | 2 | 3;
  dashed: boolean;
  head: HeadType;
  headSize: 1 | 2 | 3;
  /** Life of a new shape, ms; null = never fades. */
  fadeMs: number | null;
}

const ownIndex = (c: number) =>
  Number.isInteger(c) ? ((c % COLOUR_COUNT) + COLOUR_COUNT) % COLOUR_COUNT : 0;

/** Your own member colour, width 2, solid, a filled medium head, 30 s. */
export function defaultPrefs(ownColour: number): DrawPrefs {
  return {
    colour: ownIndex(ownColour),
    width: 2,
    dashed: false,
    head: 'fill',
    headSize: 2,
    fadeMs: DEFAULT_FADE_MS,
  };
}

const level = (v: unknown): v is 1 | 2 | 3 => v === 1 || v === 2 || v === 3;

/** Stored prefs (any shape) → valid prefs; each bad field falls back to its default. */
export function normalisePrefs(raw: unknown, ownColour: number): DrawPrefs {
  const out = defaultPrefs(ownColour);
  if (!isRecord(raw)) return out;
  const c = raw['colour'];
  if (Number.isInteger(c) && (c as number) >= 0 && (c as number) < COLOUR_COUNT) {
    out.colour = c as number;
  }
  if (level(raw['width'])) out.width = raw['width'];
  if (typeof raw['dashed'] === 'boolean') out.dashed = raw['dashed'];
  if (HEAD_TYPES.includes(raw['head'] as HeadType)) out.head = raw['head'] as HeadType;
  if (level(raw['headSize'])) out.headSize = raw['headSize'];
  if (FADE_CHOICES_MS.includes(raw['fadeMs'] as number | null)) {
    out.fadeMs = raw['fadeMs'] as number | null;
  }
  return out;
}

/** The style a stroke carries on the wire. */
export function penStyle(p: DrawPrefs): PenStyle {
  return { c: p.colour, w: p.width, d: p.dashed, ht: p.head, hs: p.headSize };
}
