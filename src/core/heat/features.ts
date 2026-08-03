import type { Feature, LineString } from 'geojson';
import type { HeatRun } from './runs';

/** Properties every rendered run feature carries (data-driven styling). */
export interface HeatRunProperties {
  trackId: string;
  categoryId: string;
  count: number;
  hot: boolean;
  color: string;
}

export function runFeatures(
  trackId: string,
  categoryId: string,
  points: readonly { latitude: number; longitude: number }[],
  runs: readonly HeatRun[],
  coldColor: string,
  hotColorHex: string,
): Feature<LineString, HeatRunProperties>[] {
  const features: Feature<LineString, HeatRunProperties>[] = [];
  for (const run of runs) {
    const coordinates: [number, number][] = [];
    for (let i = run.startIdx; i <= run.endIdx; i++) {
      const p = points[i];
      if (p) coordinates.push([p.longitude, p.latitude]);
    }
    if (coordinates.length < 2) continue;
    const hot = run.count >= 2;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
      properties: {
        trackId,
        categoryId,
        count: run.count,
        hot,
        color: hot ? hotColorHex : coldColor,
      },
    });
  }
  return features;
}
