import { fnv1a32 } from '@core/encoding/fnv1a';
import {
  planPdfDetailTiles,
  rasterCropGeometry,
  type PdfDetailBounds,
  type PdfDetailPlan,
  type PdfDetailViewport,
} from '@core/geo/pdfDetail';
import { chooseFallbackDetails } from '@core/geo/detailFallback';
import { bboxFromLngLats } from '@core/geo/geomath';
import {
  coverFromCache,
  parseTileKey,
  pdfTileBudgets,
  type TileCell,
} from '@core/geo/pdfTileCache';
import { nativePageGeometry } from '@core/geo/geopdf/pageBox';
import type { WhiteKeyLevel } from '@core/geo/pdfWhiteKey';
import { chooseRasterSource, emptyInlineReadReason } from '@core/library/rasterSource';
import {
  activeBackoff,
  emptyBackoffLedger,
  recordFailure,
  recordSuccess,
} from '@core/library/renderBackoff';
import { overlayDetailStatusKey } from '@core/library/overlayStatus';
import type { MapDocument } from '@core/models';
import * as storage from '@data/storage';
import { reportError } from '@lib/errorReporting';
import { PDF_BENCH, pdfBenchEmit } from '@lib/pdfBenchProbe';
import { useOverlayStatusStore } from '@state/overlayStatusStore';
import { useLibraryStore } from '@state/libraryStore';
import { isPdfRenderCancellation, PdfRenderNotStartedError } from './pdfRenderFailure';
import { File } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { usePdfRasterizer, usePdfRasterizerServer, type RasterizeSource } from './PdfRasterizer';
import type { PdfOverlay } from './usePdfOverlay';

interface Detail extends PdfOverlay {
  overviewKey: string;
  /** Page identity plus look: tiles of one page key are interchangeable by cell. */
  pageKey: string;
  cell: TileCell | null;
  cacheKey: string;
  pixels: number;
}
interface Target {
  key: string;
  overviewKey: string;
  pageKey: string;
  cell: TileCell | null;
  /** A neighbour outside the view, rendered ahead of a pan; never shown as such. */
  prefetch: boolean;
  id: string;
  parentId: string;
  fileUri: string;
  pageIndex: number;
  /** Size of the rendered page box the overview (and so every tile) spans. */
  pageWidthPt: number;
  pageHeightPt: number;
  /** Null when the page's rendered box disqualifies it from native rendering. */
  nativeGeometry: { expectedPageWidthPt: number; expectedPageHeightPt: number } | null;
  revision: string;
  plan: PdfDetailPlan;
  bbox: PdfOverlay['bbox'];
  /** The overview's "See-through white" level; tiles are drawn to match it. */
  whiteKey: WhiteKeyLevel;
}
const overviewKey = (o: PdfOverlay) => JSON.stringify([o.id, o.imageUri, o.coordinates]);
/** A page's file revision: a re-import or replacement starts its backoff over. */
const pageRevision = (t: Target) => `${t.fileUri}@${t.revision}`;

/** One in-flight refinement; later camera positions replace waiting work. */
export function usePdfDetails(
  maps: MapDocument[],
  overviews: PdfOverlay[],
  bounds: PdfDetailBounds | null,
  viewportWidthPx: number,
  viewport?: PdfDetailViewport,
  enabled = true,
): PdfOverlay[] {
  const rasterize = usePdfRasterizer();
  const serverOrigin = usePdfRasterizerServer();
  const [displayed, setDisplayed] = useState<Detail[]>([]);
  // After the OS warns about memory: no neighbour ring, a small cache.
  const [lowMemory, setLowMemory] = useState(false);
  const budgets = pdfTileBudgets(lowMemory);
  const VISIBLE_PIXELS = budgets.visiblePixels;
  const tileOptions = {
    prefetchMargin: budgets.prefetchMargin,
    maxPrefetch: budgets.maxPrefetchTiles,
  };
  const worker = useRef({
    epoch: 0,
    busy: false,
    desired: [] as Target[],
    cache: new Map<string, Detail>(),
    serial: 0,
    pinned: new Set<string>(),
    paused: false,
    // Pages whose last attempt failed without being quarantined (#382).
    backoff: emptyBackoffLedger(),
    // Desired tiles the cache already shows (the same cell wider, or its four
    // children): nothing to render for them.
    covered: new Set<string>(),
    budgets,
  });
  const liveOverviewKeys = overviews.map(overviewKey);
  const targets: Target[] = [];
  if (bounds) {
    // Count eligible pages before dividing the visible budget. Overviews stay
    // available for every page, including those outside this refinement budget.
    const pages = [];
    for (const o of [...overviews].reverse()) {
      const map = maps.find((m) => o.id.startsWith(`${m.id}:`));
      const pageIndex = map ? Number(o.id.slice(map.id.length + 1)) : -1;
      const geo = map?.georeferences.find((g) => g.pageIndex === pageIndex);
      if (!map || !geo || !map.activePages.includes(pageIndex)) continue;
      // `o.coordinates` are the corners of the rendered page box and
      // `pageWidthPt`/`pageHeightPt` its size, so the planner's fractional
      // crops and the renderer's crop of that same box line up (#287).
      const plans = planPdfDetailTiles(
        o.coordinates,
        { width: geo.pageWidthPt, height: geo.pageHeightPt },
        bounds,
        viewportWidthPx,
        VISIBLE_PIXELS,
        viewport,
        tileOptions,
      );
      if (!plans.some((plan) => !plan.prefetch)) continue;
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
          tileOptions,
        );
      }
      const remaining = pages.filter((page) => page.plans.some((plan) => !plan.prefetch));
      if (remaining.length === 1) {
        const page = remaining[0]!;
        page.plans = planPdfDetailTiles(
          page.o.coordinates,
          { width: page.geo.pageWidthPt, height: page.geo.pageHeightPt },
          bounds,
          viewportWidthPx,
          VISIBLE_PIXELS,
          viewport,
          tileOptions,
        );
      }
    }
    for (const { o, map, pageIndex, geo, plans } of pages) {
      const baseKey = overviewKey(o);
      const whiteKey = o.whiteKey ?? 0;
      // The white-key level is in the page key: a tile drawn at another level
      // is never reused or kept as a fallback for this one. A cell's geometry
      // follows from the overview's corners (in `baseKey`) and its grid cell.
      const pageKey = JSON.stringify([baseKey, map.fileUri, map.importedAt, whiteKey]);
      for (const plan of plans) {
        // Null for a plan off the dyadic grid: reused only by its own key.
        const cell = parseTileKey(plan.tileKey);
        targets.push({
          key: `${pageKey}|${plan.tileKey ?? JSON.stringify(plan.crop)}|${plan.targetWidthPx}`,
          overviewKey: baseKey,
          pageKey,
          cell,
          prefetch: plan.prefetch === true,
          id: `${o.id}:tile:${plan.tileKey}`,
          parentId: o.id,
          fileUri: map.fileUri,
          pageIndex,
          pageWidthPt: geo.pageWidthPt,
          pageHeightPt: geo.pageHeightPt,
          nativeGeometry: nativePageGeometry(geo),
          revision: String(map.importedAt),
          plan,
          bbox: o.bbox,
          whiteKey,
        });
      }
    }
  }
  // Everything the camera can see before any neighbour, across pages.
  targets.sort((a, b) => Number(a.prefetch) - Number(b.prefetch));
  const key = JSON.stringify(targets);
  const boundsKey = bounds ? JSON.stringify(bounds) : '';
  const liveKey = JSON.stringify(liveOverviewKeys);

  useEffect(() => {
    // Android onTrimMemory / iOS didReceiveMemoryWarning: stop prefetching
    // and shrink the cache for the rest of the session.
    const sub = AppState.addEventListener('memoryWarning', () => setLowMemory(true));
    return () => sub.remove();
  }, []);

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
    w.budgets = pdfTileBudgets(lowMemory);
    const statusKeys = new Set(
      (JSON.parse(key) as Target[])
        .filter((target) => !target.prefetch)
        .map((target) => overlayDetailStatusKey(target.parentId)),
    );
    const clearLoading = () => {
      useOverlayStatusStore.setState((state) => {
        const statuses = { ...state.statuses };
        for (const key of statusKeys) {
          if (statuses[key]?.phase === 'rendering') delete statuses[key];
        }
        return { statuses };
      });
    };
    w.paused = !enabled;
    if (!enabled) {
      // A mounted but hidden map must not compete with foreground PDF work.
      // Let its single submitted render settle into the cache, but discard all
      // waiting tiles and retain the currently displayed files for return.
      w.desired = [];
      return;
    }
    // Invalidate the old snapshot immediately, debounce only starting work.
    const next: Target[] = JSON.parse(key);
    w.desired = next;
    const cameraBox = boundsKey
      ? (() => {
          const b = JSON.parse(boundsKey) as PdfDetailBounds;
          return { minLng: b.west, minLat: b.south, maxLng: b.east, maxLat: b.north };
        })()
      : null;
    const live = new Set(JSON.parse(liveKey) as string[]);
    const publish = () => {
      if (w.paused) return;
      const { visiblePixels, fallbackPixels, maxFallbackTiles } = w.budgets;
      // Forget tiles whose file the OS reclaimed.
      for (const [cacheKey, detail] of w.cache) {
        if (!new File(detail.imageUri).exists) w.cache.delete(cacheKey);
      }
      const fresh = new Map<string, Detail>();
      const covered = new Set<string>();
      let pixels = 0;
      // Exact tiles first, then stand-ins with what is left of the budget: a
      // stand-in (four children) costs up to four times the texture of the
      // tile it replaces and must never crowd out a tile already rendered.
      for (const exactPass of [true, false]) {
        for (const target of w.desired) {
          const exact = w.cache.get(target.key);
          if ((exact !== undefined) !== exactPass) continue;
          // A wider raster of the same cell, or its four children from the
          // previous zoom, show it at least as sharp: zooming out reuses them
          // instead of rendering (and blurring) again.
          const cover = exact
            ? [exact]
            : target.cell && coverFromCache(target.pageKey, target.cell, w.cache.values());
          if (!cover) continue;
          if (target.prefetch) {
            covered.add(target.key);
            continue;
          }
          const added = cover.filter((detail) => !fresh.has(detail.cacheKey));
          const addedPixels = added.reduce((sum, detail) => sum + detail.pixels, 0);
          // Native result dimensions are authoritative, even if an unexpected
          // backend result is larger than the planner's requested raster.
          if (pixels + addedPixels > visiblePixels) continue;
          pixels += addedPixels;
          for (const detail of added) fresh.set(detail.cacheKey, detail);
          covered.add(target.key);
        }
      }
      w.covered = covered;
      // Keep the detail already rendered until its replacement arrives (#344):
      // tiles of a page still on screen stay under the fresh ones. Cached
      // tiles are ordered least-recently-used first, so reverse for MRU.
      const freshList = [...fresh.values()];
      const { keep } = chooseFallbackDetails<Detail>({
        cached: [...w.cache.values()].reverse(),
        freshKeys: new Set(fresh.keys()),
        freshBboxes: freshList.map((d) => d.bbox),
        liveOverviewKeys: live,
        bounds: cameraBox,
        budgetPixels: fallbackPixels,
        maxCount: maxFallbackTiles,
      });
      // Fallbacks first: MapLibre stacks later inserts above earlier ones
      // under the same anchor, so the fresh tiles must come last to win.
      // Among fallbacks, coarser below finer (the sharper tile stays on top),
      // in a stable order so republishing does not reshuffle mounted layers.
      keep.sort(
        (a, b) =>
          (a.cell?.divisions ?? 0) - (b.cell?.divisions ?? 0) ||
          (a.cacheKey < b.cacheKey ? -1 : a.cacheKey > b.cacheKey ? 1 : 0),
      );
      const current: Detail[] = [...keep, ...freshList];
      w.pinned = new Set(current.map((detail) => detail.imageUri));
      if (PDF_BENCH) {
        const visible = w.desired.filter((target) => !target.prefetch);
        pdfBenchEmit({
          kind: 'details',
          at: Date.now(),
          bounds: boundsKey,
          visible: visible.length,
          covered: visible.filter((target) => covered.has(target.key)).length,
          shown: current.map((detail) => detail.imageUri),
        });
      }
      setDisplayed((previous) =>
        previous.length === current.length &&
        previous.every((detail, index) => detail === current[index])
          ? previous
          : current,
      );
    };
    const prune = (budget: number) =>
      trimTileCache(w.cache, w.pinned, w.desired, w.budgets.cacheFiles, budget);
    // Reuse every cached tile in the new desired snapshot immediately. Waiting
    // for a new center tile must not hide matching neighbors during a pan.
    publish();
    prune(w.budgets.handoffPixels);
    const timer = setTimeout(() => {
      if (w.busy || w.epoch !== epoch) return;
      w.busy = true;
      void (async () => {
        while (w.epoch === epoch) {
          const snapshot = w.desired;
          const attempted = new Set<string>();
          // Tiles skipped because stand-ins showed them when their turn came.
          const stoodIn: Target[] = [];
          const failed = new Set<string>();
          for (const target of snapshot) {
            if (w.desired !== snapshot || w.epoch !== epoch) break;
            // Visible work before any neighbour: a tile whose stand-in lost
            // its place is rendered before the ring starts.
            if (
              target.prefetch &&
              stoodIn.some((t) => !w.covered.has(t.key) && !w.cache.has(t.key))
            )
              break;
            let dispatched = false;
            try {
              let detail = w.cache.get(target.key);
              if (detail && !new File(detail.imageUri).exists) {
                w.cache.delete(target.key);
                detail = undefined;
              }
              // Already on screen through a wider raster or its children.
              if (!detail && w.covered.has(target.key)) {
                stoodIn.push(target);
                continue;
              }
              if (!detail) {
                const statusKey = overlayDetailStatusKey(target.parentId);
                // A page whose last failure was not its own fault sits out a
                // growing window instead of failing — and being reported —
                // again on every pan and pinch (#382). Its status keeps the
                // reason; nothing is attempted or reported until it expires.
                const held = activeBackoff(
                  w.backoff,
                  target.parentId,
                  pageRevision(target),
                  Date.now(),
                );
                if (held) {
                  if (target.prefetch) break;
                  if (!failed.has(statusKey) && !w.paused) {
                    useOverlayStatusStore
                      .getState()
                      .setStatus(statusKey, { phase: 'failed', reason: held.reason });
                  }
                  failed.add(statusKey);
                  continue;
                }
                if (!target.prefetch) {
                  attempted.add(statusKey);
                  if (!failed.has(statusKey)) {
                    useOverlayStatusStore.getState().setStatus(statusKey, { phase: 'rendering' });
                  }
                }
                const origin = await serverOrigin();
                if (w.desired !== snapshot || w.epoch !== epoch) break;
                const documentPath = storage.toDocumentPath(target.fileUri);
                const sizeBytes = storage.fileSizeAt(target.fileUri);
                const choice = chooseRasterSource({ origin, documentPath, sizeBytes });
                if (choice.kind === 'unrenderable') throw new Error(choice.reason);
                let source: RasterizeSource;
                if (choice.kind === 'url') {
                  source = { url: choice.url };
                } else {
                  const base64 = await storage.readFileBase64(target.fileUri);
                  // An empty read is a preparation failure, not an engine
                  // that "did not start" (#382).
                  const unreadable = emptyInlineReadReason(documentPath, base64, sizeBytes);
                  if (unreadable !== null) throw new Error(unreadable);
                  source = { base64 };
                }
                if (w.desired !== snapshot || w.epoch !== epoch) break;
                dispatched = true;
                const result = await rasterize({
                  source,
                  pageIndex: target.pageIndex,
                  targetWidthPx: target.plan.targetWidthPx,
                  crop: target.plan.crop,
                  whiteKey: target.whiteKey,
                  // Neighbours wait behind anything the map is waiting for.
                  priority: target.prefetch ? 'background' : 'interactive',
                  // One open document for the whole burst of tiles, unless
                  // the OS has warned about memory.
                  holdKey: w.budgets.holdDocument ? pageRevision(target) : undefined,
                  nativePage: target.nativeGeometry && {
                    fileUri: storage.resolveDocumentPath(target.fileUri),
                    revision: target.revision,
                    ...target.nativeGeometry,
                  },
                });
                dispatched = false;
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
                  pageKey: target.pageKey,
                  cell: target.cell,
                  pixels:
                    Number.isFinite(actualPixels) && actualPixels > 0
                      ? actualPixels
                      : estimate.widthPx * estimate.heightPx,
                  id: target.id,
                  parentId: target.parentId,
                  overviewKey: target.overviewKey,
                  imageUri,
                  coordinates: target.plan.coordinates,
                  // The tile's own footprint: what it covers as a fallback.
                  bbox: bboxFromLngLats(target.plan.coordinates),
                };
                w.cache.set(target.key, detail);
                w.backoff = recordSuccess(w.backoff, target.parentId);
              }
              // Touch LRU order. Cache stale completions, but never display them.
              w.cache.delete(target.key);
              w.cache.set(target.key, detail);
              // A stale completion may be useful on a later pan. Only tiles
              // belonging to the latest desired snapshot can become visible.
              publish();
              prune(w.budgets.handoffPixels);
            } catch (error) {
              if (target.prefetch) {
                // A neighbour is a guess: its failure never fails, backs off,
                // pauses or reports the page the visible tiles belong to. Stop
                // prefetching for this snapshot; the next camera move retries.
                break;
              }
              const quarantine =
                dispatched &&
                !(error instanceof PdfRenderNotStartedError) &&
                !isPdfRenderCancellation(error) &&
                w.epoch === epoch &&
                !w.paused;
              let report = true;
              if (!quarantine && !isPdfRenderCancellation(error)) {
                // Not the page's fault, so not quarantined: back off instead,
                // and report the same failure at most once per capped window.
                const failure = recordFailure(
                  w.backoff,
                  target.parentId,
                  pageRevision(target),
                  error instanceof Error ? error.message : String(error),
                  Date.now(),
                );
                w.backoff = failure.ledger;
                report = failure.report;
              }
              if (report) reportError(error, 'pdf-detail-render');
              if (w.desired === snapshot && w.epoch === epoch && !w.paused) {
                const statusKey = overlayDetailStatusKey(target.parentId);
                if (!failed.has(statusKey)) {
                  useOverlayStatusStore.getState().setStatus(statusKey, {
                    phase: 'failed',
                    reason: error instanceof Error ? error.message : 'Failed to render PDF detail',
                  });
                }
                failed.add(statusKey);
              }
              if (quarantine) {
                // A pan supersedes a tile, not the identity of its still-active
                // page. Quarantine that page before another tile can dispatch.
                w.desired = w.desired.filter(
                  (next) =>
                    next.parentId !== target.parentId ||
                    next.fileUri !== target.fileUri ||
                    next.revision !== target.revision,
                );
                useLibraryStore
                  .getState()
                  .pauseMapPageAfterRenderFailure(
                    target.parentId.slice(0, -(String(target.pageIndex).length + 1)),
                    target.pageIndex,
                    error instanceof Error ? error.message : String(error),
                    { fileUri: target.fileUri, importedAt: Number(target.revision) },
                  );
              }
              // Preparation failures remain transient; dispatched failures pause only their page.
            }
          }
          if (w.epoch !== epoch) return;
          if (w.desired === snapshot) {
            // A stand-in can lose its place to tiles rendered after it (the
            // visible budget): go round again for the tile it stood in for.
            if (stoodIn.some((t) => !w.covered.has(t.key) && !w.cache.has(t.key))) continue;
            for (const statusKey of attempted) {
              if (!failed.has(statusKey)) {
                useOverlayStatusStore.getState().setStatus(statusKey, { phase: 'rendered' });
              }
            }
            break;
          }
        }
      })().finally(() => {
        if (w.epoch === epoch) w.busy = false;
      });
    }, 250);
    return () => {
      clearTimeout(timer);
      clearLoading();
    };
  }, [key, boundsKey, liveKey, lowMemory, rasterize, serverOrigin, enabled]);

  useEffect(() => {
    const w = worker.current;
    const timer = setTimeout(
      () =>
        trimTileCache(w.cache, w.pinned, w.desired, w.budgets.cacheFiles, w.budgets.settledPixels),
      2000,
    );
    return () => clearTimeout(timer);
  }, [displayed, lowMemory]);

  // Every tile published for a page still on screen: the fresh ones and the
  // fallbacks kept under them. Filtering by the current targets instead (as
  // before) dropped every fallback as soon as a zoom changed the keys: the
  // map went back to the blurry overview and re-rendered what it had.
  const live = new Set(liveOverviewKeys);
  return displayed.filter((d) => live.has(d.overviewKey));
}

/**
 * Delete cached tiles until the cache is within `maxFiles` and `maxPixels`:
 * least-recently-used first, tiles the camera no longer wants (not even as a
 * neighbour) before those it does. Tiles on screen are never deleted.
 */
function trimTileCache(
  cache: Map<string, Detail>,
  pinned: ReadonlySet<string>,
  desired: readonly Target[],
  maxFiles: number,
  maxPixels: number,
): void {
  let pixels = [...cache.values()].reduce((sum, detail) => sum + detail.pixels, 0);
  const wanted = new Set(desired.map((target) => target.key));
  for (const keepWanted of [true, false]) {
    for (const [cacheKey, detail] of cache) {
      if (cache.size <= maxFiles && pixels <= maxPixels) return;
      if (pinned.has(detail.imageUri) || (keepWanted && wanted.has(cacheKey))) continue;
      storage.deleteFileAt(detail.imageUri);
      cache.delete(cacheKey);
      pixels -= detail.pixels;
    }
  }
}
