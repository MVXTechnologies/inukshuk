/**
 * A shared trail on a small static map (#589): the topo tiles that frame it
 * (fetched through the app's tile disk cache, like `RegionPreviewThumb`, so
 * they show offline once seen and respect offline-only mode), the route in
 * the sharer's colour and the photo points on top. No MapLibre view: a team
 * trail screen opens fast and costs no GL surface.
 *
 * Tiles: Esri World Topo Map (key-free, the provider the region previews and
 * the 3D drape already use; raw OSM serves app UAs a policy tile, #129). In
 * the dark theme the same tiles sit under a dimming veil.
 */
import { isValidTileBytes } from '@core/geo/tileImage';
import { miniMapLayout } from '@core/teamui/miniMap';
import * as storage from '@data/storage';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useMemo, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { useTheme } from 'react-native-paper';
import Svg, { Circle, Polyline } from 'react-native-svg';

const TOPO =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}';
const UA_HEADERS = { 'User-Agent': 'Inukshuk/1.0 (offline trail navigation app)' };

export function TeamRouteMap({
  parts,
  photos,
  selected,
  color,
  width,
  height,
}: {
  parts: readonly [number, number][][];
  photos: readonly { id: string; lng: number; lat: number }[];
  selected: string | null;
  color: string;
  width: number;
  height: number;
}) {
  const t = useSchemeTokens();
  const dark = useTheme().dark;
  // Laid out at twice the size and drawn at half: crisp 256 px tiles on 2–3× screens.
  const W = width * 2;
  const H = height * 2;
  const layout = useMemo(
    () => miniMapLayout(parts.flat(), W, H, { padding: 36, maxZoom: 17 }),
    [parts, W, H],
  );
  const [uris, setUris] = useState<Record<string, string>>({});
  const keys = layout?.tiles.map((tile) => `${tile.z}-${tile.x}-${tile.y}`).join(',') ?? '';

  useEffect(() => {
    if (!layout) return;
    let cancelled = false;
    for (const tile of layout.tiles) {
      const key = `${tile.z}-${tile.x}-${tile.y}`;
      const url = TOPO.replace('{z}', String(tile.z))
        .replace('{x}', String(tile.x))
        .replace('{y}', String(tile.y));
      storage
        .downloadToCacheUri(url, `team-topo-${key}.jpg`, UA_HEADERS, isValidTileBytes)
        .then((uri) => {
          if (!cancelled) setUris((u) => ({ ...u, [key]: uri }));
        })
        .catch(() => {
          // Offline-only cache miss or no network: that tile stays blank.
        });
    }
    return () => {
      cancelled = true;
    };
    // `keys` names the tiles; the layout object changes identity with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);

  if (!layout)
    return <View style={[styles.box, { width, height, backgroundColor: t.surfaceVariant }]} />;
  const lines = parts.map((part) =>
    part
      .map(([lng, lat]) =>
        layout
          .project(lng, lat)
          .map((v) => v.toFixed(1))
          .join(','),
      )
      .join(' '),
  );
  return (
    <View
      style={[styles.box, { width, height, backgroundColor: t.surfaceVariant }]}
      accessibilityRole="image"
      accessibilityLabel="The trail on a map"
      testID="team-route-map"
    >
      <View
        style={{
          position: 'absolute',
          width: W,
          height: H,
          left: -width / 2,
          top: -height / 2,
          transform: [{ scale: 0.5 }],
        }}
      >
        {layout.tiles.map((tile) => {
          const key = `${tile.z}-${tile.x}-${tile.y}`;
          const uri = uris[key];
          return uri ? (
            <Image
              key={key}
              source={{ uri }}
              style={[styles.tile, { left: tile.left, top: tile.top }]}
              fadeDuration={0}
            />
          ) : null;
        })}
        {dark && (
          <View
            style={[StyleSheet.absoluteFill, { backgroundColor: t.background, opacity: 0.38 }]}
          />
        )}
        <Svg width={W} height={H} style={StyleSheet.absoluteFill}>
          {lines.map((pts, i) => (
            <Polyline
              key={`c${i}`}
              points={pts}
              fill="none"
              stroke={t.team.mapPaper}
              strokeWidth={12}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {lines.map((pts, i) => (
            <Polyline
              key={`l${i}`}
              points={pts}
              fill="none"
              stroke={color}
              strokeWidth={7}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {photos.map((p) => {
            const [x, y] = layout.project(p.lng, p.lat);
            const on = p.id === selected;
            return (
              <Circle
                key={p.id}
                cx={x}
                cy={y}
                r={on ? 14 : 10}
                fill={on ? t.team.mapInk : t.team.mapPaper}
                stroke={t.team.mapInk}
                strokeWidth={4}
              />
            );
          })}
        </Svg>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: 14, overflow: 'hidden' },
  tile: { position: 'absolute', width: 256, height: 256 },
});
