/**
 * Paint for the Explore map's point layers, as plain MapLibre style values so
 * the reference validator can check them in a unit test (MapLibre iOS crashes
 * on an expression Android tolerates — notably a `['zoom']` curve nested inside
 * `match`/`case`; none is used here, and the test keeps it that way).
 *
 * Two kinds of point read apart by SHAPE as well as colour, so they stay
 * distinct in the high-contrast theme where every explorer colour is black:
 *
 * - a map sheet (downloadable) is a solid disc with a thin light ring;
 * - a place (link-out: a park, a reserve, a zec) is a light disc inside a
 *   thick coloured ring.
 *
 * Both have the same outer radius (10 px), so neither outweighs the other.
 */

export interface ExplorePointColors {
  cluster: string;
  clusterRing: string;
  clusterInk: string;
  /** A downloadable map sheet. */
  map: string;
  /** A link-out place. */
  place: string;
}

type Expression = readonly unknown[];

const byKind = <T extends string | number>(place: T, map: T): Expression => [
  'match',
  ['get', 'kind'],
  'place',
  place,
  map,
];

export const EXPLORE_CLUSTER_FILTER: Expression = ['has', 'point_count'];
export const EXPLORE_POINT_FILTER: Expression = ['!', ['has', 'point_count']];

/** Clusters grow in three steps with their count. */
export function exploreClusterPaint(colors: ExplorePointColors) {
  return {
    'circle-color': colors.cluster,
    'circle-radius': ['step', ['get', 'point_count'], 18, 10, 22, 50, 27],
    'circle-stroke-width': 3,
    'circle-stroke-color': colors.clusterRing,
  } as const;
}

/** Single points, styled per kind (`properties.kind`: 'map' | 'place'). */
export function explorePointPaint(colors: ExplorePointColors) {
  return {
    'circle-color': byKind(colors.clusterRing, colors.map),
    'circle-radius': byKind(6, 8),
    'circle-stroke-width': byKind(4, 2),
    'circle-stroke-color': byKind(colors.place, colors.clusterRing),
  } as const;
}

export const EXPLORE_CLUSTER_COUNT_LAYOUT = {
  'text-field': ['get', 'point_count_abbreviated'],
  'text-size': 14,
  'text-allow-overlap': true,
} as const;
