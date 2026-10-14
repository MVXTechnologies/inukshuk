import { formatDistance, headingToCardinal, type Units } from '@core/format';

import { bearingDeg, haversineM, type Pt } from './geo';
import type { ShapeKind } from './record';
import type { DrawShape } from './view';

/**
 * What a shape's card and its menu say (#683): its kind, its age, how long
 * it has left (with the life bar), where Navigate goes and how far that is.
 */
export const SHAPE_NAMES: Readonly<Record<ShapeKind, string>> = {
  free: 'pencil line',
  arrow: 'arrow',
  circle: 'circle',
  rect: 'rectangle',
};

/**
 * Navigate's target: an arrow's head, a circle's or rectangle's centre, a
 * line's end; null for a shape without its points (the view never yields one).
 */
export function navTarget(s: Pick<DrawShape, 'sh' | 'pts'>): Pt | null {
  const [a, b, c] = s.pts;
  if (s.sh === 'arrow') return b ?? null;
  if (s.sh === 'rect') {
    return a !== undefined && c !== undefined ? [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2] : null;
  }
  if (s.sh === 'circle') return a ?? null;
  return s.pts[s.pts.length - 1] ?? null;
}

const TARGET_WORD: Readonly<Record<ShapeKind, string>> = {
  free: 'end',
  arrow: 'head',
  circle: 'centre',
  rect: 'centre',
};

/** A duration, short: "45 s", "28 min", "2 h 10 min"; `exact` adds seconds to minutes ("4 min 10 s"). */
export function durationText(ms: number, exact = false): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = exact ? Math.floor(s / 60) : Math.round(s / 60);
  if (m < 60) {
    const rest = s % 60;
    return exact && rest > 0 ? `${m} min ${rest} s` : `${m} min`;
  }
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm > 0 ? `${h} h ${mm} min` : `${h} h`;
}

/** "Drawn just now", "Drawn 2 min ago", "Drawn 1 h ago". */
export function ageText(created: number, now: number): string {
  const ms = now - created;
  if (ms < 60_000) return 'Drawn just now';
  return `Drawn ${durationText(ms)} ago`;
}

export interface LifeText {
  /** Share of the life still left, 0–1 (null: never fades). */
  left: number | null;
  /** "Fades in 28 min", or "Never fades". */
  text: string;
  /** "of 30 min" (null: never fades). */
  of: string | null;
}

export function lifeText(
  s: Pick<DrawShape, 'created' | 'expires'>,
  now: number,
  exact = false,
): LifeText {
  if (s.expires === null) return { left: null, text: 'Never fades', of: null };
  const life = Math.max(1, s.expires - s.created);
  const remaining = Math.max(0, s.expires - now);
  return {
    left: Math.min(1, remaining / life),
    text: `Fades in ${durationText(remaining, exact)}`,
    of: `of ${durationText(life)}`,
  };
}

/** "head 640 m NE of you" (null without my position). */
export function whereText(
  s: Pick<DrawShape, 'sh' | 'pts'>,
  here: Pt | null,
  units: Units,
): string | null {
  const t = navTarget(s);
  if (here === null || t === null) return null;
  const d = haversineM(here, t);
  const where =
    d < 5 ? 'here' : `${formatDistance(d, units)} ${headingToCardinal(bearingDeg(here, t))} of you`;
  return `${TARGET_WORD[s.sh]} ${where}`;
}
