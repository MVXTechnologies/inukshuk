import { pointInRing, polygonAreaM2, polygonPerimeterM } from '@core/draw/geometry';
import { sanitizeVertices } from '@core/draw/serialize';
import type { Units } from '@core/format';
import type { Area, LngLat } from '@core/models';

import { compactDistance } from './libraryRows';

/**
 * Library-side rules for drawn areas (#503): the colour palette, the
 * persisted-shape normalizer the migration runs, the "Area N" auto name, tag
 * clean-up and the size readout ("0.42 km²" / "4.2 ha" / "10.4 ac").
 *
 * Pure.
 */

export interface AreaColor {
  /** `#RRGGBB`. */
  hex: string;
  /** Spoken name (the swatch's accessibility label). */
  name: string;
}

/**
 * Swatches for an area's fill + outline. Saturated mid-tones: the outline must
 * hold on the light paper map, the dark map and satellite imagery alike, and
 * the 18 % fill stays a tint, never a block.
 */
export const AREA_COLORS: readonly AreaColor[] = [
  { hex: '#2563EB', name: 'Blue' },
  { hex: '#3E8E5A', name: 'Green' },
  { hex: '#C96A1F', name: 'Orange' },
  { hex: '#C62828', name: 'Red' },
  { hex: '#8A63C9', name: 'Violet' },
  { hex: '#2E8FA8', name: 'Teal' },
];

export const DEFAULT_AREA_COLOR = AREA_COLORS[0]!.hex;

/** Longest kept tag (after trimming). */
export const MAX_TAG_LENGTH = 24;
/** Most tags on one area. */
export const MAX_TAGS = 12;

const isHexColor = (v: unknown): v is string =>
  typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v);

/** Trimmed, non-empty, de-duplicated (case-insensitively), bounded tags. */
export function normalizeTags(raw: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const tag = entry.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH);
    const key = tag.toLowerCase();
    if (tag === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Split typed tag text ("Berries, private") into tags. */
export function parseTagInput(text: string): string[] {
  return normalizeTags(text.split(/[,;\n]/));
}

/**
 * A persisted area, normalized — or null when it cannot be drawn (no id, or
 * fewer than three valid vertices). Junk optional fields are dropped, an
 * unknown colour falls back to the default: never lose an area to a bad tag.
 */
export function normalizeArea(raw: unknown): Area | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id === '') return null;
  const ring = sanitizeVertices(r.ring);
  if (ring.length < 3) return null;
  const photoUris = Array.isArray(r.photoUris)
    ? r.photoUris.filter((u): u is string => typeof u === 'string' && u !== '')
    : [];
  const tags = Array.isArray(r.tags) ? normalizeTags(r.tags) : [];
  return {
    id: r.id,
    name: typeof r.name === 'string' && r.name.trim() !== '' ? r.name : 'Area',
    ring,
    color: isHexColor(r.color) ? r.color : DEFAULT_AREA_COLOR,
    ...(typeof r.note === 'string' && r.note !== '' ? { note: r.note } : {}),
    ...(photoUris.length > 0 ? { photoUris } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(typeof r.folderId === 'string' ? { folderId: r.folderId } : {}),
    createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0,
    ...(typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt)
      ? { updatedAt: r.updatedAt }
      : {}),
  };
}

const AUTO_NAME = /^Area (\d+)$/;

/** "Area N", numbered past the highest existing auto name. */
export function nextAreaName(existing: readonly string[]): string {
  let max = 0;
  for (const name of existing) {
    const m = AUTO_NAME.exec(name.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Area ${max + 1}`;
}

const M2_PER_HA = 10_000;
const M2_PER_KM2 = 1_000_000;
const M2_PER_ACRE = 4046.8564224;
const M2_PER_MI2 = 2_589_988.110336;
const M2_PER_FT2 = 0.09290304;

const trim = (n: number, digits: number): string => {
  const s = n.toFixed(digits);
  return digits > 0 ? s.replace(/\.?0+$/, '') : s;
};

/**
 * An area's size: m² under a hectare, hectares under 10 ha, km² above
 * (metric); ft² under a tenth of an acre, acres under a square mile, mi²
 * above (imperial).
 */
export function formatAreaSize(m2: number, units: Units): string {
  const a = Number.isFinite(m2) && m2 > 0 ? m2 : 0;
  if (units === 'imperial') {
    const acres = a / M2_PER_ACRE;
    if (acres < 0.1) return `${Math.round(a / M2_PER_FT2).toLocaleString('en-US')} ft²`;
    if (a < M2_PER_MI2) return `${trim(acres, acres < 10 ? 2 : 1)} ac`;
    return `${trim(a / M2_PER_MI2, 2)} mi²`;
  }
  if (a < M2_PER_HA) return `${Math.round(a).toLocaleString('en-US')} m²`;
  if (a < 10 * M2_PER_HA) return `${trim(a / M2_PER_HA, 1)} ha`;
  const km2 = a / M2_PER_KM2;
  return `${trim(km2, km2 < 10 ? 2 : 1)} km²`;
}

/** "Area · 0.42 km² · perimeter 2.6 km" — the card's subtitle. */
export function areaSummaryLine(ring: Area['ring'], units: Units): string {
  return `Area · ${formatAreaSize(polygonAreaM2(ring), units)} · perimeter ${compactDistance(
    polygonPerimeterM(ring),
    units,
  )}`;
}

/** Newest first, like the waypoint list. */
export function sortAreasNewestFirst(areas: readonly Area[]): Area[] {
  return [...areas].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The area a map tap at `point` lands in: the SMALLEST one containing it, so
 * a small area drawn inside a big one stays reachable. Null for none.
 */
export function areaAt(areas: readonly Area[], point: LngLat): Area | null {
  let best: Area | null = null;
  let bestSize = Infinity;
  for (const area of areas) {
    if (!pointInRing(point, area.ring)) continue;
    const size = polygonAreaM2(area.ring);
    if (size < bestSize) {
      best = area;
      bestSize = size;
    }
  }
  return best;
}
