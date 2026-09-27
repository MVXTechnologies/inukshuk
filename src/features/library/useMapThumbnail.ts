import { primaryGeoreferences } from '@core/geo/geopdf/primary';
import { documentRevision, rasterFileName } from '@core/library/overlayRaster';
import type { MapDocument } from '@core/models';
import * as storage from '@data/storage';
import { useEffect, useState } from 'react';

export interface MapThumbnail {
  /** file:// uri of page 1's overview raster, when the overlay pipeline already drew it. */
  uri: string | null;
  /** The PDF's size on disk in bytes (0 when unknown). */
  bytes: number;
}

/**
 * A map row's thumbnail and size, looked up after render (both touch the
 * filesystem, and the raster check may discard a truncated PNG).
 *
 * The thumbnail is the first georeferenced page's overlay raster — the PNG
 * the map's overlay pipeline and the import-time pre-render already write
 * (`@core/library/overlayRaster`). Nothing new is rendered here; a map whose
 * page has not been drawn yet shows the neutral sheet placeholder.
 */
export function useMapThumbnail(map: MapDocument, rendering: boolean): MapThumbnail | undefined {
  const pageIndex = primaryGeoreferences(map.georeferences)[0]?.pageIndex;
  const revision = documentRevision(map);
  const key = `${map.id}|${revision}|${pageIndex ?? ''}|${map.activePages.join(',')}|${rendering}`;
  const [found, setFound] = useState<{ key: string; value: MapThumbnail }>();

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      let uri: string | null = null;
      let bytes = 0;
      try {
        if (pageIndex !== undefined) {
          uri = storage.existingOverlayPng(rasterFileName(map.id, pageIndex, revision));
        }
        bytes = storage.fileSizeAt(map.fileUri);
      } catch {
        // Decoration only: fall back to the placeholder and no size.
      }
      if (!cancelled) setFound({ key, value: { uri, bytes } });
    });
    return () => {
      cancelled = true;
    };
  }, [key, map.id, map.fileUri, pageIndex, revision]);

  return found?.key === key ? found.value : undefined;
}
