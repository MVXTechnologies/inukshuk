import type { CatalogItem, CatalogSource } from '@core/catalog/schema';

import {
  groupBySource,
  lineHitsBox,
  segmentHitsBox,
  topoGroupTitle,
  topoMapsAlong,
} from './catalogAlong';
import { CAPS_LINE } from './__fixtures__/trails';

const item = (
  id: string,
  bbox: [number, number, number, number],
  extra: Partial<CatalogItem> = {},
) =>
  ({
    id,
    sourceId: 'cantopo',
    title: id,
    category: 'topo',
    bbox,
    format: 'geopdf',
    packaging: 'zip',
    url: `https://example.org/${id}.zip`,
    scale: 50000,
    ...extra,
  }) as CatalogItem;

const SOURCES = [
  { id: 'cantopo', name: 'NRCan CanTopo', licence: 'OGL-Canada-2.0' },
  { id: 'usgs', name: 'USGS US Topo', licence: 'Public domain' },
] as CatalogSource[];

describe('topo maps along a trail', () => {
  it('clips segments against boxes', () => {
    expect(segmentHitsBox([0, 0], [2, 2], [0.5, 0.5, 1, 1])).toBe(true);
    // The diagonal's bbox overlaps, but the segment misses the corner box.
    expect(segmentHitsBox([0, 0], [2, 2], [1.5, 0, 2, 0.4])).toBe(false);
    expect(segmentHitsBox([0, 0.5], [0, 0.5], [-1, 0, 1, 1])).toBe(true);
    expect(segmentHitsBox([5, 5], [6, 6], [0, 0, 1, 1])).toBe(false);
    expect(segmentHitsBox([0, 2], [2, 2], [0, 0, 1, 1])).toBe(false);
    expect(lineHitsBox([[[0.5, 0.5]]], [0, 0, 1, 1])).toBe(true);
  });

  it('keeps only topo sheets the line crosses', () => {
    const items = [
      item('on', [-70.8, 47.1, -70.6, 47.25]),
      item('corner', [-70.62, 47.12, -70.57, 47.16]), // inside the trail bbox, off the line
      item('far', [-60, 40, -59, 41]),
      item('park', [-70.8, 47.1, -70.6, 47.25], { category: 'parks', kind: 'park' }),
      item('nobox', [0, 0, 0, 0], { bbox: undefined }),
    ];
    expect(topoMapsAlong(items, [CAPS_LINE]).map((i) => i.id)).toEqual(['on']);
    expect(topoMapsAlong(items, [])).toEqual([]);
  });

  it('groups per publisher with the common scale', () => {
    const groups = groupBySource(
      [
        item('a', [0, 0, 1, 1]),
        item('b', [0, 0, 1, 1], { scale: 250000 }),
        item('c', [0, 0, 1, 1]),
        item('d', [0, 0, 1, 1], { sourceId: 'usgs', scale: undefined }),
        item('e', [0, 0, 1, 1], { sourceId: 'mystery' }),
      ],
      SOURCES,
    );
    expect(groups.map((g) => g.sourceId)).toEqual(['cantopo', 'mystery', 'usgs']);
    expect(groups[0]).toMatchObject({ scale: 50000, licence: 'OGL-Canada-2.0' });
    expect(groups[1]?.sourceName).toBe('mystery');
    expect(groups[2]?.scale).toBeNull();
    expect(topoGroupTitle(groups[0]!, 'NRCan')).toBe('3 NRCan sheets · 1:50 000');
    expect(topoGroupTitle(groups[2]!, 'USGS')).toBe('1 USGS sheet');
  });
});
