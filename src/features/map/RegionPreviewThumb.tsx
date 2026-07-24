/**
 * RegionPreviewThumb — a small live preview of the drawn region in one basemap
 * style. Rather than spin up a full MapLibre instance per basemap (heavy: 3 GL
 * surfaces alongside the main map), it fetches the single tile that best frames
 * the box and shows it as an Image.
 *
 * The tile is fetched through `storage.downloadBytes`' disk cache with an
 * app-identifying User-Agent — NOT with a bare RN `<Image source={{ uri }}>`.
 * A bare RN Image request sends no User-Agent, which OSM's tile usage policy
 * rejects: the server answers with an "Access blocked" placeholder *image*
 * (a real 200-ish tile, so `onError` never fires) and that's exactly what the
 * user saw in the thumb. Going through the shared tile cache also makes the
 * preview work offline once the tile has been seen, and respects offline-only
 * mode (a cache miss falls back to the placeholder instead of fetching).
 *
 * The 'map' preview does NOT fetch raw tile.openstreetmap.org: OSM's CDN now
 * serves the "Access blocked" policy tile (as an HTTP **200** PNG) to app
 * User-Agents — including our own identifying UA — which is exactly what the
 * first iOS run rendered (#129). Like the 3D drape (see dem.ts), the preview
 * uses Esri's permissive World Street Map instead. Downloaded bytes are also
 * validated (`isValidTileBytes`) so a policy/error tile can neither render nor
 * stay poisoning the cache.
 */

import { basemapTileUrl } from './mapStyle';
import { isValidTileBytes } from '@core/geo/tileImage';
import { centerTileForRegion } from '@core/geo/tiles';
import type { Basemap } from '@core/geo/tiles';
import type { BoundingBox } from '@core/models';
import * as storage from '@data/storage';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { Icon, useTheme } from 'react-native-paper';

interface Props {
  bbox: BoundingBox | null;
  basemap: Basemap;
  tileUrl: string;
  /** Square edge (px) — or pass width/height for a banner crop. */
  size: number;
  width?: number;
  height?: number;
}

// Same self-identification as the 3D DEM/basemap fetches (see dem.ts) — the
// OSM tile policy requires it, and Esri appreciates it.
const UA_HEADERS = { 'User-Agent': 'Inukshuk/1.0 (offline trail navigation app)' };

interface PreviewTile {
  url: string;
  /** Cache file name — keyed by basemap + z/x/y, like the DEM tile names. */
  cacheName: string;
}

// Street-map preview tiles come from Esri World Street Map (`{z}/{y}/{x}`
// order), the same key-free service the 3D drape uses — raw OSM blocks app
// UAs with a policy tile (#129). The cache name is keyed to the source, so
// any `preview-map-*` entries poisoned by the old OSM fetch are never reused.
const STREET_PREVIEW_TEMPLATE =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';

function previewTile(bbox: BoundingBox, basemap: Basemap, tileUrl: string): PreviewTile | null {
  const template = basemap === 'map' ? STREET_PREVIEW_TEMPLATE : basemapTileUrl(basemap, tileUrl);
  if (!template) return null;
  const { x, y, z } = centerTileForRegion(bbox);
  return {
    url: template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)),
    cacheName:
      basemap === 'map'
        ? `preview-mapstreet-${z}-${x}-${y}.png`
        : `preview-${basemap}-${z}-${x}-${y}.png`,
  };
}

export function RegionPreviewThumb({
  bbox,
  basemap,
  tileUrl,
  size,
  width,
  height,
}: Props): ReactElement {
  const theme = useTheme();
  const tile = useMemo(
    () => (bbox && tileUrl ? previewTile(bbox, basemap, tileUrl) : null),
    [bbox, basemap, tileUrl],
  );

  // The local (cache-file) uri of the last successfully fetched tile, tagged
  // with the remote url it came from so a stale image is never shown for a
  // different tile. `bbox` changes on every drag frame but the framing tile's
  // z/x/y is discrete, so the effect keys on the url strings (not the `tile`
  // object identity) and refetches only when the target tile really changes —
  // and even then it's usually a disk-cache hit.
  const [loaded, setLoaded] = useState<{ url: string; localUri: string } | null>(null);
  const url = tile?.url ?? null;
  const cacheName = tile?.cacheName ?? null;
  useEffect(() => {
    if (url === null || cacheName === null) return;
    let cancelled = false;
    (async () => {
      try {
        const localUri = await storage.downloadToCacheUri(
          url,
          cacheName,
          UA_HEADERS,
          isValidTileBytes,
        );
        if (!cancelled) setLoaded({ url, localUri });
      } catch {
        // Fetch failed (offline-only cache miss, network error, server block):
        // keep whatever was shown before; the placeholder covers the rest.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, cacheName]);

  const imageUri = url !== null && loaded !== null && loaded.url === url ? loaded.localUri : null;

  const box = { width: width ?? size, height: height ?? size, borderRadius: 8 };
  return (
    <View style={[styles.frame, box, { borderColor: theme.colors.outlineVariant }]}>
      {imageUri !== null ? (
        <Image
          source={{ uri: imageUri }}
          style={[box, styles.image]}
          resizeMode="cover"
          // Undecodable cached file (e.g. a truncated write) — drop back to the
          // placeholder rather than showing a broken image.
          onError={() => setLoaded(null)}
        />
      ) : (
        <View style={[box, styles.placeholder, { backgroundColor: theme.colors.surfaceVariant }]}>
          <Icon source="map-outline" size={size * 0.4} color={theme.colors.onSurfaceVariant} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
