/**
 * The line overlays the native 3D scene draws on the terrain (#735). The 3D
 * terrain covers the whole 2D map, so every line overlay visible in 2D is
 * also handed to the scene as polylines lifted onto the relief. Each overlay
 * sends its own group: a live stroke or a new GPS fix re-sends one group, not
 * every trail in the Library.
 *
 * Pure: ids, ranges and packing. The overlay components choose the colours
 * and widths (the same tokens as their 2D layers).
 */
import {
  sceneLines,
  type LineGeometry,
  type LineStyleInput,
  type TerrainLineSpec,
} from './sceneInput';

/** Every overlay with its own group, in draw order (later on top at equal style order). */
export const TERRAIN_LINE_GROUPS = [
  'trails', // the Library's trails shown on the map (imported / opened GPX included)
  'focusedTrail',
  'shownTrail', // a long-distance trail shown from Explore, and its stage
  'areas', // the Library's areas (outlines)
  'teamTracks',
  'teamDrawings',
  'drawing', // the route being drawn
  'followedTrail',
  'followGuide',
  'pointingLine',
  'recording',
] as const;
export type TerrainLineGroup = (typeof TERRAIN_LINE_GROUPS)[number];

/** Ids per group: group k owns [GROUP_SPAN·(k+1), GROUP_SPAN·(k+2)). Group 0 is the legacy setLines. */
export const GROUP_SPAN = 1_000_000;

export function groupIndex(group: TerrainLineGroup): number {
  return TERRAIN_LINE_GROUPS.indexOf(group) + 1;
}

export function groupBase(group: TerrainLineGroup): number {
  return groupIndex(group) * GROUP_SPAN;
}

/** The group a line id belongs to (null outside every group). */
export function groupOfId(id: number): TerrainLineGroup | null {
  const k = Math.floor(id / GROUP_SPAN) - 1;
  return TERRAIN_LINE_GROUPS[k] ?? null;
}

export interface GroupFeature {
  geometry: LineGeometry;
  /** Overrides the style's colour (e.g. a trail's category, a stroke's colour). */
  color?: string | null;
  /** Overrides the style's width (e.g. a drawing's stroke width). */
  width?: number | null;
  /** Overrides the style's opacity (a fading stroke). */
  opacity?: number | null;
  /** Overrides the halo colour and its extra width (a selected stroke's wide halo). */
  halo?: string | null;
  haloAdd?: number | null;
  /** Overrides the order within the group (0–9; e.g. a stage over its trail). */
  order?: number | null;
}

/**
 * A group's lines: one spec per part, ids `groupBase + k` (stable while the
 * features keep their order). Features may override colour, width, opacity
 * and halo. The draw order is the group's (its TERRAIN_LINE_GROUPS place) × 10
 * plus the style's own (0–9, within the group).
 */
export function groupLines(
  group: TerrainLineGroup,
  features: readonly GroupFeature[],
  style: LineStyleInput,
): TerrainLineSpec[] {
  const base = groupBase(group);
  const out: TerrainLineSpec[] = [];
  for (const f of features) {
    const lines = sceneLines(
      [{ geometry: f.geometry, color: f.color }],
      {
        ...style,
        width: f.width ?? style.width,
        opacity: f.opacity ?? style.opacity,
        halo: f.halo ?? style.halo,
        haloAdd: f.haloAdd ?? style.haloAdd,
        order: groupIndex(group) * 10 + Math.min(9, Math.max(0, f.order ?? style.order)),
      },
      base + out.length,
    );
    for (const l of lines) {
      if (out.length >= GROUP_SPAN) return out;
      out.push(l);
    }
  }
  return out;
}

/** A closed ring (an area's outline) as a line: the first point repeated at the end. */
export function ringAsLine(ring: readonly (readonly number[])[]): LineGeometry {
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closed =
    first !== undefined && last !== undefined && (first[0] !== last[0] || first[1] !== last[1])
      ? [...ring, first]
      : [...ring];
  return { type: 'LineString', coordinates: closed };
}
