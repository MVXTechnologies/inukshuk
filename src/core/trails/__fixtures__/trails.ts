import type { LngLat } from '@core/models';

import { encodePolyline } from '../polyline';
import {
  parseTrailDetail,
  parseTrailIndex,
  type LongTrail,
  type TrailDetail,
  type TrailIndex,
} from '../schema';

/**
 * Small hand-made trails for the long-distance trail tests (#467), shaped
 * like the pilot build's output (Charlevoix, the Long Trail, the TMB).
 */

export const QUEBEC_CITY: LngLat = [-71.2082, 46.8139];

export const CAPS_LINE: LngLat[] = [
  [-70.754, 47.12],
  [-70.7, 47.16],
  [-70.66, 47.22],
  [-70.62, 47.27],
  [-70.571, 47.312],
];

export const LONG_TRAIL_LINE: LngLat[] = [
  [-73.25, 42.74],
  [-72.95, 43.3],
  [-72.85, 43.9],
  [-72.8, 44.5],
  [-72.55, 45.01],
];

export const TMB_LINE: LngLat[] = [
  [6.79, 45.9],
  [6.95, 45.8],
  [7.1, 45.85],
  [7.05, 46.05],
  [6.87, 45.99],
  [6.79, 45.9],
];

function row(
  id: string,
  name: string,
  line: LngLat[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const lons = line.map((p) => p[0]);
  const lats = line.map((p) => p[1]);
  const mid = line[Math.floor(line.length / 2)] ?? line[0];
  return {
    id,
    n: name,
    a: ['hiking'],
    net: 'r',
    km: 50,
    b: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
    c: mid,
    p: 0.5,
    t: [encodePolyline(line, 4)],
    ...extra,
  };
}

export function rawIndex(): Record<string, unknown> {
  return {
    schema: 1,
    generated: '2026-09-29T00:00:00Z',
    details: 'pilot1',
    attribution: '© OpenStreetMap contributors (ODbL)',
    countries: {
      CA: ['Canada', 'North America'],
      US: ['United States', 'North America'],
      FR: ['France', 'Europe'],
      IT: ['Italy', 'Europe'],
      CH: ['Switzerland', 'Europe'],
    },
    trails: [
      row('r8730405', 'Sentier des Caps de Charlevoix', CAPS_LINE, {
        net: 'o',
        km: 43.3,
        p: 0.19,
        cc: ['CA'],
        rg: 'Québec',
        st: 4,
      }),
      row('r391736', 'Long Trail', LONG_TRAIL_LINE, {
        net: 'n',
        km: 440,
        p: 0.72,
        cc: ['US'],
        rg: 'Vermont',
      }),
      row('r9454', 'Tour du Mont-Blanc', TMB_LINE, {
        net: 'i',
        km: 170,
        p: 0.9,
        cc: ['FR', 'IT', 'CH'],
        a: ['hiking', 'foot'],
      }),
      row('r416109', 'Route Verte 5', [QUEBEC_CITY, [-72.5, 46.3]], {
        a: ['bicycle'],
        net: 'n',
        km: 745.9,
        p: 0.66,
        cc: ['CA'],
        fr: 'Québec',
        to: 'Montréal',
      }),
    ],
  };
}

export function sampleIndex(): TrailIndex {
  const parsed = parseTrailIndex(rawIndex()).value;
  if (parsed === null) throw new Error('fixture index does not parse');
  return parsed;
}

export function trailById(index: TrailIndex, id: string): LongTrail {
  const t = index.trails.find((x) => x.id === id);
  if (t === undefined) throw new Error(`no fixture trail ${id}`);
  return t;
}

export const STAGE_LINES: LngLat[][] = [
  [
    [-70.754, 47.12],
    [-70.72, 47.14],
  ],
  [
    [-70.72, 47.14],
    [-70.68, 47.19],
  ],
  [
    [-70.68, 47.19],
    [-70.63, 47.26],
  ],
  [
    [-70.63, 47.26],
    [-70.571, 47.312],
  ],
];

export function rawDetail(withStages = true): Record<string, unknown> {
  return {
    schema: 1,
    id: 'r8730405',
    name: 'Sentier des Caps de Charlevoix',
    names: { en: 'Charlevoix Capes Trail' },
    acts: ['hiking'],
    net: 'o',
    km: 43.3,
    bbox: [-70.754, 47.12, -70.571, 47.312],
    from: 'Saint-Tite-des-Caps',
    to: 'Petite-Rivière-Saint-François',
    operator: 'Sentier des Caps',
    website: 'https://sentierdescaps.com',
    ...(withStages
      ? {
          stages: STAGE_LINES.map((line, i) => ({
            id: `r${100 + i}`,
            name: `Étape ${i + 1}`,
            km: 10.8,
            geom: [encodePolyline(line)],
          })),
        }
      : { geom: [encodePolyline(CAPS_LINE)] }),
  };
}

export function sampleDetail(withStages = true): TrailDetail {
  const parsed = parseTrailDetail(rawDetail(withStages));
  if (parsed === null) throw new Error('fixture detail does not parse');
  return parsed;
}
