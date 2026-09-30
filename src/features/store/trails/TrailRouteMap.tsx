import { VECTOR_BASEMAP_ENABLED } from '@core/features/flags';
import { toBoundingBox } from '@core/trails/geometry';
import type { TrailDetail } from '@core/trails/schema';
import { trailMarkers } from '@core/trails/stages';
import { vectorBasemapOption } from '@data/basemapTiles';
import { toLngLatBounds } from '@features/map/geojson';
import { buildOsmStyle } from '@features/map/mapStyle';
import { Camera, type CameraRef, GeoJSONSource, Layer, Map } from '@maplibre/maplibre-react-native';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo, useCallback, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from 'react-native-paper';

/**
 * The trail page's route map (#467, board `Detail.dc.html`): the app's own
 * base map, the trail as an orange line over a halo, stage joins as dots, the
 * start as an open ring and the finish as a filled one. A picture, not a
 * control — every gesture is off and touches fall through to the page's
 * scroll; "Show on map" is the way to explore it.
 */
export const TrailRouteMap = memo(function TrailRouteMap({
  detail,
  height,
  topInset,
}: {
  detail: TrailDetail;
  height: number;
  /** Room kept clear at the top (status bar + back button). */
  topInset: number;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  const tileUrl = useSettingsStore((s) => s.tileUrl);
  const showHillshade = useSettingsStore((s) => s.showHillshade);
  const cameraRef = useRef<CameraRef>(null);

  const style = useMemo(
    () =>
      buildOsmStyle(
        tileUrl,
        false,
        'map',
        showHillshade,
        VECTOR_BASEMAP_ENABLED ? { vectorBasemap: vectorBasemapOption(theme.dark, false) } : {},
      ),
    [tileUrl, showHillshade, theme.dark],
  );

  const line = useMemo(
    () => ({
      type: 'Feature' as const,
      geometry: { type: 'MultiLineString' as const, coordinates: detail.geometry },
      properties: {},
    }),
    [detail],
  );
  const markers = useMemo(() => {
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

  const fit = useCallback(() => {
    cameraRef.current?.fitBounds(toLngLatBounds(toBoundingBox(detail.bbox)), {
      duration: 0,
      padding: { top: topInset + 24, right: 32, bottom: 28, left: 32 },
    });
  }, [detail, topInset]);

  return (
    <View style={{ height }} pointerEvents="none" accessible={false}>
      <Map
        style={styles.fill}
        mapStyle={style}
        compass={false}
        attribution={false}
        logo={false}
        dragPan={false}
        touchZoom={false}
        doubleTapZoom={false}
        touchRotate={false}
        touchPitch={false}
        onDidFinishLoadingMap={fit}
      >
        <Camera ref={cameraRef} />
        <GeoJSONSource id="long-trail-route" data={line}>
          <Layer
            id="long-trail-route-halo"
            type="line"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': t.explore.trailHalo, 'line-width': 8 }}
          />
          <Layer
            id="long-trail-route-line"
            type="line"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': t.explore.trail, 'line-width': 4 }}
          />
        </GeoJSONSource>
        <GeoJSONSource id="long-trail-route-marks" data={markers}>
          <Layer
            id="long-trail-route-marks-dot"
            type="circle"
            paint={{
              'circle-radius': ['match', ['get', 'kind'], 'join', 4.5, 7],
              'circle-color': [
                'match',
                ['get', 'kind'],
                'start',
                t.explore.trailHalo,
                t.explore.trail,
              ],
              'circle-stroke-width': ['match', ['get', 'kind'], 'join', 0, 3],
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
      </Map>
    </View>
  );
});

const styles = StyleSheet.create({ fill: { flex: 1 } });
