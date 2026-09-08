import { fnv1a32 } from '@core/encoding/fnv1a';
import { planPdfDetail, type PdfDetailBounds } from '@core/geo/pdfDetail';
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
}
interface Target {
  key: string;
  overviewKey: string;
  id: string;
  fileUri: string;
  pageIndex: number;
  plan: NonNullable<ReturnType<typeof planPdfDetail>>;
  bbox: PdfOverlay['bbox'];
}
const overviewKey = (o: PdfOverlay) => JSON.stringify([o.id, o.imageUri, o.coordinates]);

/** One in-flight refinement; later camera positions replace waiting work. */
export function usePdfDetails(
  maps: MapDocument[],
  overviews: PdfOverlay[],
  bounds: PdfDetailBounds | null,
  viewportWidthPx: number,
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
    // Topmost pages first; limiting refinement does not remove any overview.
    for (const o of [...overviews].reverse()) {
      const map = maps.find((m) => o.id.startsWith(`${m.id}:`));
      const pageIndex = map ? Number(o.id.slice(map.id.length + 1)) : -1;
      const geo = map?.georeferences.find((g) => g.pageIndex === pageIndex);
      if (!map || !geo) continue;
      const plan = planPdfDetail(
        o.coordinates,
        { width: geo.pageWidthPt, height: geo.pageHeightPt },
        bounds,
        viewportWidthPx,
      );
      if (!plan) continue;
      const baseKey = overviewKey(o);
      targets.push({
        key: JSON.stringify([baseKey, map.fileUri, map.importedAt, plan]),
        overviewKey: baseKey,
        id: o.id,
        fileUri: map.fileUri,
        pageIndex,
        plan,
        bbox: o.bbox,
      });
      if (targets.length === 2) break;
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
    const timer = setTimeout(() => {
      if (w.busy || w.epoch !== epoch) return;
      w.busy = true;
      void (async () => {
        while (w.epoch === epoch) {
          const snapshot = w.desired;
          const results: Detail[] = [];
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
                });
                if (w.epoch !== epoch) return;
                const imageUri = storage.writeOverlayPng(
                  `pdf-detail-${fnv1a32(target.key)}-${++w.serial}`,
                  result.pngDataUri.replace(/^data:image\/png;base64,/, ''),
                );
                detail = {
                  id: target.id,
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
              results.push(detail);
              // Bound superseded completions too: a moving camera may never
              // reach setDisplayed. Keep two handoff images beyond the four
              // settled cache entries, and never remove a currently shown URI.
              for (const [oldKey, old] of w.cache) {
                if (w.cache.size <= 6) break;
                if (w.pinned.has(old.imageUri) || results.some((d) => d.imageUri === old.imageUri))
                  continue;
                storage.deleteFileAt(old.imageUri);
                w.cache.delete(oldKey);
              }
            } catch (error) {
              reportError(error, 'pdf-detail-render');
              // The overview stays available if refinement fails.
            }
          }
          if (w.epoch !== epoch) return;
          if (w.desired === snapshot) {
            w.pinned = new Set(results.map((d) => d.imageUri));
            setDisplayed(results);
            // Retain the previous two generations as well as the current pair
            // until MapLibre has had time to release their image URLs.
            break;
          }
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
      const pinned = new Set(displayed.map((d) => d.imageUri));
      for (const [cacheKey, detail] of w.cache) {
        if (w.cache.size <= 4) break;
        if (pinned.has(detail.imageUri)) continue;
        storage.deleteFileAt(detail.imageUri);
        w.cache.delete(cacheKey);
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [displayed]);

  const live = new Set(targets.map((t) => t.overviewKey));
  return displayed.filter((d) => live.has(d.overviewKey));
}
