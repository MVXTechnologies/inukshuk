import type { GeoJSONSource, LayerSpecification, Map as MlMap } from 'maplibre-gl';
import { useEffect } from 'react';

import type { StoreSheet } from '@/store/facets';
import type { Theme } from '@/ui/theme';

/**
 * Coverage footprints for whatever the store filter currently matches.
 *
 * A map store on a map should say *where* on the map, and every catalogue item
 * already carries a real `bbox` — so the filtered rows are drawn as their own
 * sheet outlines rather than left as a list of names. Tapping a facet then has
 * a visible consequence on the map as well as on the count, which is the whole
 * argument for filtering on top of a map instead of on a page.
 *
 * Registered like `useLibraryLayers`: rebuilt on every `style.load`, because
 * `setStyle` throws every layer away. It draws under nothing else, since the
 * store never runs at the same time as the Library.
 */

const SOURCE = 'store-coverage';
const LAYER_IDS = ['store-coverage-line', 'store-coverage-fill'] as const;

/** Enough outlines to read as coverage; past this it is a solid smear. */
const MAX_FOOTPRINTS = 400;

function layers(theme: Theme): LayerSpecification[] {
  const ink = theme.dark ? '#5CB0E8' : '#1A72AD';
  return [
    {
      id: 'store-coverage-fill',
      type: 'fill',
      source: SOURCE,
      paint: { 'fill-color': ink, 'fill-opacity': theme.dark ? 0.13 : 0.1 },
    },
    {
      id: 'store-coverage-line',
      type: 'line',
      source: SOURCE,
      paint: {
        'line-color': ink,
        'line-opacity': 0.75,
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 12, 1.4],
      },
    },
  ];
}

const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

export function useStoreLayers(
  map: MlMap | null,
  styleEpoch: number,
  theme: Theme,
  sheets: readonly StoreSheet[],
): void {
  useEffect(() => {
    if (map === null || styleEpoch === 0) return;
    if (map.getSource(SOURCE) === undefined) {
      map.addSource(SOURCE, { type: 'geojson', data: empty() });
    }
    for (const layer of layers(theme)) {
      if (map.getLayer(layer.id) === undefined) map.addLayer(layer);
    }
    return () => {
      if (!map.getStyle()) return;
      for (const id of LAYER_IDS) {
        if (map.getLayer(id) !== undefined) map.removeLayer(id);
      }
    };
  }, [map, styleEpoch, theme]);

  useEffect(() => {
    if (map === null || styleEpoch === 0) return;
    const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
    source?.setData({
      type: 'FeatureCollection',
      features: sheets.slice(0, MAX_FOOTPRINTS).flatMap((sheet) => {
        if (sheet.bbox === null) return [];
        const [w, s, e, n] = sheet.bbox;
        return [
          {
            type: 'Feature' as const,
            id: sheet.id,
            properties: { title: sheet.title },
            geometry: {
              type: 'Polygon' as const,
              coordinates: [
                [
                  [w, s],
                  [e, s],
                  [e, n],
                  [w, n],
                  [w, s],
                ],
              ],
            },
          },
        ];
      }),
    });
  }, [map, styleEpoch, sheets]);
}
