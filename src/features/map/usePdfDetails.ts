import { fnv1a32 } from '@core/encoding/fnv1a';
import {
  planPdfDetailTiles,
  rasterCropGeometry,
  type PdfDetailBounds,
  type PdfDetailPlan,
  type PdfDetailViewport,
} from '@core/geo/pdfDetail';
import { chooseRasterSource } from '@core/library/rasterSource';
import type { MapDocument } from '@core/models';
import * as storage from '@data/storage';
import { reportError } from '@lib/errorReporting';
import { File } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import { usePdfRasterizer, usePdfRasterizerServer } from './PdfRasterizer';
import type { PdfOverlay } from './usePdfOverlay';

interface Detail extends PdfOverlay {
  overviewKey: string;
  cacheKey: string;
  pixels: number;
}
interface Target {
  key: string;
  overviewKey: string;
  id: string;
  parentId: string;
  fileUri: string;
  pageIndex: number;
  pageWidthPt: number;
  pageHeightPt: number;
  revision: string;
  plan: PdfDetailPlan;
  bbox: PdfOverlay['bbox'];
}
const VISIBLE_PIXELS = 6 * 1024 * 1024;
const HANDOFF_PIXELS = 18 * 1024 * 1024;
const SETTLED_PIXELS = 12 * 1024 * 1024;
const MAX_CACHE_FILES = 64;
const overviewKey = (o: PdfOverlay) => JSON.stringify([o.id, o.imageUri, o.coordinates]);

/** One in-flight refinement; later camera positions replace waiting work. */
export function usePdfDetails(
  maps: MapDocument[],
  overviews: PdfOverlay[],
  bounds: PdfDetailBounds | null,
  viewportWidthPx: number,
  viewport?: PdfDetailViewport,
): PdfOverlay[] {
  const rasterize = usePdfRasterizer();
  const serverOrigin = usePdfRasterizerServer();
  const [displayed, setDisplayed] = useState<Detail[]>([]);
  const worker = useRef({
    epoch: 0,
    busy: false,
    desired: [] as Target[],
    cache: new Map<string, Detail>(),
    serial: 0,
    pinned: new Set<string>(),
  });
  const targets: Target[] = [];
  if (bounds) {
    // Count eligible pages before dividing the visible budget. Overviews stay
    // available for every page, including those outside this refinement budget.
    const pages = [];
    for (const o of [...overviews].reverse()) {
      const map = maps.find((m) => o.id.startsWith(`${m.id}:`));
      const pageIndex = map ? Number(o.id.slice(map.id.length + 1)) : -1;
      const geo = map?.georeferences.find((g) => g.pageIndex === pageIndex);
      if (!map || !geo) continue;
      const plans = planPdfDetailTiles(
        o.coordinates,
        { width: geo.pageWidthPt, height: geo.pageHeightPt },
        bounds,
        viewportWidthPx,
        VISIBLE_PIXELS,
        viewport,
      );
      if (!plans.length) continue;
      pages.push({ o, map, pageIndex, geo, plans });
      if (pages.length === 2) break;
    }
    if (pages.length === 2) {
      for (const page of pages) {
        page.plans = planPdfDetailTiles(
          page.o.coordinates,
          { width: page.geo.pageWidthPt, height: page.geo.pageHeightPt },
          bounds,
          viewportWidthPx,
          VISIBLE_PIXELS / 2,
          viewport,
        );
      }
      const remaining = pages.filter((page) => page.plans.length);
      if (remaining.length === 1) {
        const page = remaining[0]!;
        page.plans = planPdfDetailTiles(
          page.o.coordinates,
          { width: page.geo.pageWidthPt, height: page.geo.pageHeightPt },
          bounds,
          viewportWidthPx,
          VISIBLE_PIXELS,
          viewport,
        );
      }
    }
    for (const { o, map, pageIndex, geo, plans } of pages) {
      const baseKey = overviewKey(o);
      for (const plan of plans) {
        targets.push({
          key: JSON.stringify([baseKey, map.fileUri, map.importedAt, plan]),
          overviewKey: baseKey,
          id: `${o.id}:tile:${plan.tileKey}`,
          parentId: o.id,
          fileUri: map.fileUri,
          pageIndex,
          pageWidthPt: geo.pageWidthPt,
          pageHeightPt: geo.pageHeightPt,
          revision: String(map.importedAt),
          plan,
          bbox: o.bbox,
        });
      }
    }
  }
  const key = JSON.stringify(targets);

  useEffect(() => {
    const w = worker.current;
    w.epoch += 1;
    storage.clearPdfDetailPngs();
    return () => {
      w.epoch += 1;
      w.busy = false;
      w.desired = [];
      for (const entry of w.cache.values()) storage.deleteFileAt(entry.imageUri);
      w.cache.clear();
    };
  }, []);

  useEffect(() => {
    const w = worker.current;
    const epoch = w.epoch;
    // Invalidate the old snapshot immediately, debounce only starting work.
    const next: Target[] = JSON.parse(key);
    w.desired = next;
    const publish = () => {
      const current: Detail[] = [];
      let pixels = 0;
      for (const target of w.desired) {
        const detail = w.cache.get(target.key);
        if (!detail) continue;
        if (!new File(detail.imageUri).exists) {
          w.cache.delete(target.key);
          continue;
        }
        // Native result dimensions are authoritative, even if an unexpected
        // backend result is larger than the planner's requested raster.
        if (pixels + detail.pixels > VISIBLE_PIXELS) continue;
        pixels += detail.pixels;
        current.push(detail);
      }
      w.pinned = new Set(current.map((detail) => detail.imageUri));
      setDisplayed((previous) =>
        previous.length === current.length &&
        previous.every((detail, index) => detail === current[index])
          ? previous
          : current,
      );
    };
    const prune = (budget: number) => {
      let pixels = [...w.cache.values()].reduce((sum, detail) => sum + detail.pixels, 0);
      for (const [cacheKey, detail] of w.cache) {
        if (w.cache.size <= MAX_CACHE_FILES && pixels <= budget) break;
        if (w.pinned.has(detail.imageUri)) continue;
        storage.deleteFileAt(detail.imageUri);
        w.cache.delete(cacheKey);
        pixels -= detail.pixels;
      }
    };
    // Reuse every cached tile in the new desired snapshot immediately. Waiting
    // for a new center tile must not hide matching neighbors during a pan.
    publish();
    prune(HANDOFF_PIXELS);
    const timer = setTimeout(() => {
      if (w.busy || w.epoch !== epoch) return;
      w.busy = true;
      void (async () => {
        while (w.epoch === epoch) {
          const snapshot = w.desired;
          for (const target of snapshot) {
            if (w.desired !== snapshot || w.epoch !== epoch) break;
            try {
              let detail = w.cache.get(target.key);
              if (detail && !new File(detail.imageUri).exists) {
                w.cache.delete(target.key);
                detail = undefined;
              }
              if (!detail) {
                const origin = await serverOrigin();
                if (w.desired !== snapshot || w.epoch !== epoch) break;
                const choice = chooseRasterSource({
                  origin,
                  documentPath: storage.toDocumentPath(target.fileUri),
                  sizeBytes: storage.fileSizeAt(target.fileUri),
                });
                if (choice.kind === 'unrenderable') throw new Error(choice.reason);
                const source =
                  choice.kind === 'url'
                    ? { url: choice.url }
                    : { base64: await storage.readFileBase64(target.fileUri) };
                if (w.desired !== snapshot || w.epoch !== epoch) break;
                const result = await rasterize({
                  source,
                  pageIndex: target.pageIndex,
                  targetWidthPx: target.plan.targetWidthPx,
                  crop: target.plan.crop,
                  nativePage: {
                    fileUri: storage.resolveDocumentPath(target.fileUri),
                    revision: target.revision,
                    expectedPageWidthPt: target.pageWidthPt,
                    expectedPageHeightPt: target.pageHeightPt,
                  },
                });
                if (w.epoch !== epoch) {
                  if (result.fileUri !== undefined) storage.deleteFileAt(result.fileUri);
                  return;
                }
                const imageUri =
                  result.fileUri !== undefined
                    ? result.fileUri
                    : storage.writeOverlayPng(
                        `pdf-detail-${fnv1a32(target.key)}-${++w.serial}`,
                        result.pngDataUri.replace(/^data:image\/png;base64,/, ''),
                      );
                const estimate = rasterCropGeometry(
                  target.pageWidthPt,
                  target.pageHeightPt,
                  target.plan.targetWidthPx,
                  target.plan.crop,
                );
                const actualPixels = result.widthPx * result.heightPx;
                detail = {
                  cacheKey: target.key,
                  pixels:
                    Number.isFinite(actualPixels) && actualPixels > 0
                      ? actualPixels
                      : estimate.widthPx * estimate.heightPx,
                  id: target.id,
                  parentId: target.parentId,
                  overviewKey: target.overviewKey,
                  imageUri,
                  coordinates: target.plan.coordinates,
                  bbox: target.bbox,
                };
                w.cache.set(target.key, detail);
              }
              // Touch LRU order. Cache stale completions, but never display them.
              w.cache.delete(target.key);
              w.cache.set(target.key, detail);
              // A stale completion may be useful on a later pan. Only tiles
              // belonging to the latest desired snapshot can become visible.
              publish();
              prune(HANDOFF_PIXELS);
            } catch (error) {
              reportError(error, 'pdf-detail-render');
              // The overview stays available if refinement fails.
            }
          }
          if (w.epoch !== epoch) return;
          if (w.desired === snapshot) break;
        }
      })().finally(() => {
        if (w.epoch === epoch) w.busy = false;
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [key, rasterize, serverOrigin]);

  useEffect(() => {
    const w = worker.current;
    const timer = setTimeout(() => {
      let pixels = [...w.cache.values()].reduce((sum, detail) => sum + detail.pixels, 0);
      for (const [cacheKey, detail] of w.cache) {
        if (w.cache.size <= MAX_CACHE_FILES && pixels <= SETTLED_PIXELS) break;
        if (w.pinned.has(detail.imageUri)) continue;
        storage.deleteFileAt(detail.imageUri);
        w.cache.delete(cacheKey);
        pixels -= detail.pixels;
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [displayed]);

  const live = new Set(targets.map((t) => t.key));
  return displayed.filter((d) => live.has(d.cacheKey));
}
