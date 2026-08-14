import type { BoundingBox, GeoReference, LngLat, MapDocument } from '@core/models';
import {
  bboxFromCorners,
  cornersAreValid,
  extrapolatePageCorners,
  isDegenerateBBox,
} from '@core/geo/geomath';
import { primaryGeoreferenceForPage } from '@core/geo/geopdf/primary';
import * as storage from '@data/storage';
import { reportError } from '@lib/errorReporting';
import { File } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { usePdfRasterizer } from './PdfRasterizer';

export interface PdfOverlay {
  /** Stable id `${docId}:${pageIndex}`, also used as the MapLibre source id. */
  id: string;
  /** `file://` uri of the rasterized PNG (MapLibre can't take a data: URI). */
  imageUri: string;
  /** MapLibre ImageSource ordering: top-left, top-right, bottom-right, bottom-left. */
  coordinates: [LngLat, LngLat, LngLat, LngLat];
  bbox: BoundingBox;
}

export interface PdfOverlaysState {
  overlays: PdfOverlay[];
  loading: boolean;
  error: string | null;
}

interface Target {
  docId: string;
  fileUri: string;
  geo: GeoReference;
}

/**
 * Target raster width in CSS px. Matches the rasterizer's own default; passed
 * explicitly so the cache key below always names the width it was rendered at.
 */
const OVERLAY_TARGET_WIDTH_PX = 2048;

/**
 * Cache of already-rasterized overlay PNGs: `${docId}:${pageIndex}:${widthPx}`
 * → the written `file://` uri. Rasterizing costs a full base64 read of the PDF
 * plus a WebView render, so entries live at module level to survive page
 * activation toggles and screen remounts. Entries are pruned when their map is
 * removed from the library. The PNG files themselves sit in the OS-managed
 * cache directory (see storage.writeOverlayPng) and — as before this cache
 * existed — are left to the OS to reclaim; this hook never owned their deletion.
 */
const rasterCache = new Map<string, string>();

function rasterCacheKey(docId: string, pageIndex: number): string {
  return `${docId}:${pageIndex}:${OVERLAY_TARGET_WIDTH_PX}`;
}

/**
 * Collect every active, georeferenced page across all imported maps.
 *
 * `activePages` is de-duplicated here as well as in the persistence migration:
 * builds before the primary-viewport fix stored one entry per *viewport*, so a
 * three-viewport US Topo / AUSTopo sheet persisted `[0, 0, 0]` and would
 * otherwise push three identical targets — three stacked copies of the same
 * raster, compounded opacity and three native layers for one map.
 */
export function activeTargets(maps: MapDocument[]): Target[] {
  const targets: Target[] = [];
  for (const m of maps) {
    if (!m.fileUri) continue;
    for (const pageIndex of new Set(m.activePages)) {
      // The PRIMARY viewport, not the first one listed: AUSTopo sheets put a
      // whole-of-Australia locator inset ahead of the map, and taking the
      // first georeference draws the sheet stretched across the continent.
      const geo = primaryGeoreferenceForPage(m.georeferences, pageIndex);
      if (geo) targets.push({ docId: m.id, fileUri: m.fileUri, geo });
    }
  }
  return targets;
}

/**
 * Rasterize every active georeferenced page across all maps and compute each
 * page's full-page geographic corners (the rasterizer renders the whole page;
 * georeferencing may only describe the inner map frame — we extrapolate affinely
 * from the viewport corners). Pages whose corners are non-finite, out of range,
 * or degenerate are skipped (never handed to MapLibre) so a bad georeference can
 * never crash the native layer.
 *
 * Rasterization is cached (see `rasterCache`): when the active set changes,
 * only pages that have never been rendered (or whose PNG was purged) go
 * through the rasterizer; everything else reuses its existing PNG file.
 */
export function usePdfOverlays(maps: MapDocument[]): PdfOverlaysState {
  const rasterize = usePdfRasterizer();
  const [state, setState] = useState<PdfOverlaysState>({
    overlays: [],
    loading: false,
    error: null,
  });

  const targets = activeTargets(maps);
  // A stable key over the active set; the effect re-runs only when it changes.
  const key = targets.map((t) => `${t.docId}:${t.geo.pageIndex}`).join('|');

  // Drop cache entries whose map left the library. Keyed on `maps` (not `key`):
  // removing an already-deactivated map never changes the active-set key.
  useEffect(() => {
    const live = new Set(maps.map((m) => m.id));
    for (const k of rasterCache.keys()) {
      const docId = k.slice(0, k.indexOf(':'));
      if (!live.has(docId)) rasterCache.delete(k);
    }
  }, [maps]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (targets.length === 0) {
        if (!cancelled) setState({ overlays: [], loading: false, error: null });
        return;
      }
      setState((s) => ({ ...s, loading: true, error: null }));

      const overlays: PdfOverlay[] = [];
      let firstError: string | null = null;

      // Group by document so a multi-MB PDF is base64-read at most once per
      // batch — and not at all when every one of its pages hits the cache.
      const byDoc = new Map<string, Target[]>();
      for (const t of targets) {
        const list = byDoc.get(t.docId);
        if (list) list.push(t);
        else byDoc.set(t.docId, [t]);
      }

      for (const docTargets of byDoc.values()) {
        // Read lazily, only when some page of this document misses the cache.
        let base64: string | null = null;
        for (const t of docTargets) {
          try {
            const { geo } = t;
            const pageRect = { x0: 0, y0: 0, x1: geo.pageWidthPt, y1: geo.pageHeightPt };
            const corners = extrapolatePageCorners(
              geo.viewport.rect,
              geo.viewport.corners,
              pageRect,
            );
            const bbox = bboxFromCorners(corners);
            if (!cornersAreValid(corners) || isDegenerateBBox(bbox)) {
              firstError ??= `Page ${geo.pageIndex + 1} has invalid georeferencing — skipped`;
              continue;
            }
            // The raster is geo-independent (the whole page at a fixed width),
            // so a cached PNG stays valid even if the georeference changes;
            // only the corners above are recomputed. The OS may purge the cache
            // directory at any time, so verify the file still exists.
            let imageUri = rasterCache.get(rasterCacheKey(t.docId, geo.pageIndex));
            if (imageUri && !new File(imageUri).exists) {
              rasterCache.delete(rasterCacheKey(t.docId, geo.pageIndex));
              imageUri = undefined;
            }
            if (!imageUri) {
              base64 ??= await storage.readFileBase64(t.fileUri);
              const raster = await rasterize({
                base64,
                pageIndex: geo.pageIndex,
                targetWidthPx: OVERLAY_TARGET_WIDTH_PX,
              });
              if (cancelled) return;
              // MapLibre's ImageSource needs a file:// url, not a data: URI — write
              // the rasterized PNG to the cache and reference it by file path.
              const pngBase64 = raster.pngDataUri.replace(/^data:image\/png;base64,/, '');
              imageUri = storage.writeOverlayPng(`${t.docId}_${geo.pageIndex}`, pngBase64);
              rasterCache.set(rasterCacheKey(t.docId, geo.pageIndex), imageUri);
            }
            overlays.push({
              id: `${t.docId}:${geo.pageIndex}`,
              imageUri,
              coordinates: [
                corners.topLeft,
                corners.topRight,
                corners.bottomRight,
                corners.bottomLeft,
              ],
              bbox,
            });
          } catch (err) {
            if (cancelled) return;
            reportError(err, 'pdf-overlay-render');
            firstError ??= err instanceof Error ? err.message : 'Failed to render a PDF page';
          }
        }
      }

      if (!cancelled) setState({ overlays, loading: false, error: firstError });
    })();

    return () => {
      cancelled = true;
    };
    // rasterize identity is stable from the provider; `key` captures the targets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}
