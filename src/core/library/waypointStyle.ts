import type { WaypointSize } from '@core/models';

import { waypointIconLabel } from './waypointIcons';

/**
 * How a waypoint pin looks (#675): its colour, its size and the ink its glyph
 * is drawn in. Pure, shared by the editor's preview, the map's symbol layers,
 * the GPX extension and team shares, so all four agree on what is valid.
 */

/** One swatch of the editor's palette. */
export interface WaypointColor {
  /** `#RRGGBB`, upper case: what is persisted. */
  hex: string;
  /** Spoken and shown name ("Orange"). */
  name: string;
}

/**
 * The 18 swatches, in the editor's order (two rows of nine): warm to cool,
 * then earth, stone and paper. Carmine is kept although the geodetic marks use
 * it (owner decision on the mockup): pins are teardrops, marks are small
 * symbols.
 */
export const WAYPOINT_COLORS: readonly WaypointColor[] = [
  { hex: '#D32F2F', name: 'Red' },
  { hex: '#E8612C', name: 'Orange' },
  { hex: '#F57C00', name: 'Pumpkin' },
  { hex: '#F2A900', name: 'Amber' },
  { hex: '#FBC02D', name: 'Yellow' },
  { hex: '#9CCC65', name: 'Lime' },
  { hex: '#43A047', name: 'Green' },
  { hex: '#2E7D32', name: 'Forest' },
  { hex: '#00897B', name: 'Teal' },
  { hex: '#00ACC1', name: 'Cyan' },
  { hex: '#039BE5', name: 'Sky' },
  { hex: '#1E64C8', name: 'Blue' },
  { hex: '#3949AB', name: 'Indigo' },
  { hex: '#7E57C2', name: 'Purple' },
  { hex: '#C2185B', name: 'Carmine' },
  { hex: '#6D4C41', name: 'Brown' },
  { hex: '#2D3740', name: 'Stone' },
  { hex: '#FBF8F2', name: 'Paper' },
];

/** A pin with no colour: today's sage (`mapColors.userLocation`), unchanged. */
export const DEFAULT_WAYPOINT_COLOR = '#566B33';
export const DEFAULT_WAYPOINT_COLOR_NAME = 'Default colour';

/** Glyph ink on a dark fill, and on a light one. */
export const WAYPOINT_INK_LIGHT = '#FFFFFF';
export const WAYPOINT_INK_DARK = '#1E252C';
/** The pin's ring: paper, except around the paper pin, which gets stone. */
export const WAYPOINT_RING = '#FBF8F2';
export const WAYPOINT_RING_ON_PAPER = '#2D3740';

const HEX = /^#[0-9a-f]{6}$/i;

/** Whether a stored or foreign value is a colour a pin can be drawn in. */
export function isWaypointColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

/** A colour as persisted (`#RRGGBB`, upper case), or `undefined` for junk. */
export function normalizeWaypointColor(value: unknown): string | undefined {
  return isWaypointColor(value) ? value.toUpperCase() : undefined;
}

/** The fill a pin draws with. */
export function waypointFill(color: string | undefined): string {
  return normalizeWaypointColor(color) ?? DEFAULT_WAYPOINT_COLOR;
}

/** Swatch name of a colour; a foreign one (from GPX or a teammate) is "Custom colour". */
export function waypointColorName(color: string | undefined): string {
  const hex = normalizeWaypointColor(color);
  if (hex === undefined) return DEFAULT_WAYPOINT_COLOR_NAME;
  return WAYPOINT_COLORS.find((c) => c.hex === hex)?.name ?? 'Custom colour';
}

function channel(hex: string, at: number): number {
  const c = parseInt(hex.slice(at, at + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#RRGGBB` colour. */
export function relativeLuminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** WCAG contrast ratio between two `#RRGGBB` colours. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The glyph ink for a fill: white wherever white keeps 3:1 (the WCAG ratio
 * for graphics), else the dark stone ink — amber, yellow, lime, paper, and
 * also cyan and pumpkin, whose white glyphs measured 2.7:1.
 */
export function waypointInk(color: string | undefined): string {
  const fill = waypointFill(color);
  return contrastRatio(WAYPOINT_INK_LIGHT, fill) >= 3 ? WAYPOINT_INK_LIGHT : WAYPOINT_INK_DARK;
}

/** The pin's ring colour for a fill. */
export function waypointRing(color: string | undefined): string {
  return waypointFill(color) === WAYPOINT_RING ? WAYPOINT_RING_ON_PAPER : WAYPOINT_RING;
}

// ── Size ────────────────────────────────────────────────────────────────────

export const WAYPOINT_SIZES: readonly WaypointSize[] = ['S', 'M', 'L', 'XL'];
export const DEFAULT_WAYPOINT_SIZE: WaypointSize = 'M';

/** Pin head diameter per size, dp (the mockup's 26/32/40/50). */
export const WAYPOINT_PIN_DIAMETER: Readonly<Record<WaypointSize, number>> = {
  S: 26,
  M: 32,
  L: 40,
  XL: 50,
};

const SIZE_NAMES: Readonly<Record<WaypointSize, string>> = {
  S: 'Small',
  M: 'Medium',
  L: 'Large',
  XL: 'Extra large',
};

export function isWaypointSize(value: unknown): value is WaypointSize {
  return value === 'S' || value === 'M' || value === 'L' || value === 'XL';
}

/** The size a pin draws at. */
export function waypointSize(size: WaypointSize | undefined): WaypointSize {
  return size !== undefined && isWaypointSize(size) ? size : DEFAULT_WAYPOINT_SIZE;
}

/** Spoken name of a size ("Large"). */
export function waypointSizeName(size: WaypointSize | undefined): string {
  return SIZE_NAMES[waypointSize(size)];
}

/**
 * Pin geometry for a head diameter `d`: a disc with one sharp corner pointing
 * down (a square rotated 45° with three rounded corners), so the head's centre
 * sits `d·√2/2` above the tip and the whole pin is `d·(1/2 + √2/2)` tall.
 */
export function pinGeometry(d: number): { width: number; height: number; headCenterY: number } {
  const headCenterY = d * Math.SQRT1_2;
  return { width: d, height: d / 2 + headCenterY, headCenterY };
}

/** The editor's preview caption: "Tent · Orange · L". */
export function waypointStyleCaption(w: {
  icon?: string;
  color?: string;
  size?: WaypointSize;
}): string {
  return [waypointIconLabel(w.icon), waypointColorName(w.color), waypointSize(w.size)].join(' · ');
}

/** The optional style fields of a waypoint, validated (junk dropped). */
export interface WaypointStyleFields {
  color?: string;
  size?: WaypointSize;
}

/** Keep a valid colour and size, drop anything else (persisted or foreign input). */
export function normalizeWaypointStyle(raw: {
  color?: unknown;
  size?: unknown;
}): WaypointStyleFields {
  const color = normalizeWaypointColor(raw.color);
  return {
    ...(color !== undefined ? { color } : {}),
    ...(isWaypointSize(raw.size) ? { size: raw.size } : {}),
  };
}
