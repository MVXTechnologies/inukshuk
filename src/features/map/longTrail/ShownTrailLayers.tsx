import { trailMarkers } from '@core/trails/stages';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import type { ShownTrail } from '@state/longTrailsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useMemo } from 'react';

/**
 * Stage joins stay small at a continental zoom (the Appalachian Trail's eleven
 * would bead the whole line) and grow as you zoom in; start / finish stay 7.
 * The zoom curve MUST be the top-level expression: MapLibre iOS throws an
 * uncaught NSInvalidArgumentException ("zoom" expression may only be used as
 * input to a top-level "step" or "interpolate") for a curve nested in a
 * `match`, which crashed the app on "Show on map". Android merely ignored it.
 */
export const SHOWN_MARK_RADIUS = [
  'interpolate',
  ['linear'],
  ['zoom'],
  4,
  ['match', ['get', 'kind'], 'join', 2.5, 7],
  10,
  ['match', ['get', 'kind'], 'join', 4.5, 7],
] as const;

/**
 * A long-distance trail shown on the main map (#467, board `OnMap.dc.html`):
 * the whole trail as an orange line over a halo, the selected stage drawn
 * heavier on top, and the start / finish / stage-join dots. Mounted as MapView
 * children (no style reload), with no anchor layer, so it sits above the base
 * map and overlays like the Library's trails.
 */
export function ShownTrailLayers({ shown }: { shown: ShownTrail }) {
  const t = useSchemeTokens();
  const { detail, stageIndex } = shown;

  const line = useMemo(
    () => ({
      type: 'Feature' as const,
      geometry: { type: 'MultiLineString' as const, coordinates: detail.geometry },
      properties: {},
    }),
    [detail],
  );
  const stage = stageIndex === null ? undefined : detail.stages[stageIndex];
  const stageLine = useMemo(
    () =>
      stage === undefined
        ? null
        : {
            type: 'Feature' as const,
            geometry: { type: 'MultiLineString' as const, coordinates: stage.geometry },
            properties: {},
          },
    [stage],
  );
  const marks = useMemo(() => {
    const m = trailMarkers(detail);
    const point = (c: [number, number], kind: string) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: c },
      properties: { kind },
    });
    return {
      type: 'FeatureCollection' as const,
      features: [
        ...m.joins.map((p) => point(p, 'join')),
        ...(m.finish !== null ? [point(m.finish, 'finish')] : []),
        ...(m.start !== null ? [point(m.start, 'start')] : []),
      ],
    };
  }, [detail]);

  return (
    <>
      <GeoJSONSource id="long-trail-shown" data={line}>
        <Layer
          id="long-trail-shown-halo"
          type="line"
          layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          paint={{ 'line-color': t.explore.trailHalo, 'line-width': 10, 'line-opacity': 0.9 }}
        />
        <Layer
          id="long-trail-shown-line"
          type="line"
          layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          paint={{ 'line-color': t.explore.trail, 'line-width': 5 }}
        />
      </GeoJSONSource>
      {stageLine !== null && (
        <GeoJSONSource id="long-trail-shown-stage" data={stageLine}>
          <Layer
            id="long-trail-shown-stage-line"
            type="line"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': t.explore.trailStage, 'line-width': 7 }}
          />
        </GeoJSONSource>
      )}
      <GeoJSONSource id="long-trail-shown-marks" data={marks}>
        <Layer
          id="long-trail-shown-marks-dot"
          type="circle"
          paint={{
            'circle-radius': SHOWN_MARK_RADIUS as never,
            'circle-color': [
              'match',
              ['get', 'kind'],
              'start',
              t.explore.trailHalo,
              t.explore.trail,
            ],
            'circle-stroke-width': ['match', ['get', 'kind'], 'join', 1.5, 3],
            'circle-stroke-color': [
              'match',
              ['get', 'kind'],
              'start',
              t.explore.trail,
              t.explore.trailHalo,
            ],
          }}
        />
      </GeoJSONSource>
    </>
  );
}
