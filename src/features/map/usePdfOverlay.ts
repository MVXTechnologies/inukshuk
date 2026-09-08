import { fnv1a32 } from '@core/encoding/fnv1a';
import type { BoundingBox, GeoReference, LngLat, MapDocument } from '@core/models';
import {
  bboxFromCorners,
  cornersAreValid,
  extrapolatePageCorners,
  isDegenerateBBox,
} from '@core/geo/geomath';
import { primaryGeoreferenceForPage } from '@core/geo/geopdf/primary';
import { unsupportedProjectionNotice } from '@core/library/overlayPages';
import { overlayStatusKey } from '@core/library/overlayStatus';
import { chooseRasterSource } from '@core/library/rasterSource';
import * as storage from '@data/storage';
import { reportError } from '@lib/errorReporting';
import { useOverlayStatusStore } from '@state/overlayStatusStore';
import { useEffect, useRef, useState } from 'react';
import { usePdfRasterizer, usePdfRasterizerServer, type RasterizeSource } from './PdfRasterizer';

export interface PdfOverlay {
  /** Stable id `${docId}:${pageIndex}`, also used as the MapLibre source id. */
  id: string;
  /** Owning page overlay for a detail tile; overviews have no parent. */
  parentId?: string;
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
  revision: string;
  geo: GeoReference;
}

/**
 * Target raster width in CSS px. Matches the rasterizer's own default; passed
 * explicitly so the cache key below always names the width it was rendered at.
 */
const OVERLAY_TARGET_WIDTH_PX = 2048;

/**
 * Cache of already-rasterized overlay PNGs: `${docId}:${revision}:${pageIndex}:${widthPx}`
 * → the written `file://` uri. Rasterizing costs a WebView render of the page
 * (and, on the bridge fallback, a full base64 read of the PDF), so entries
 * live at module level to survive page activation toggles and screen
 * remounts. Entries are pruned when their map is removed from the library.
 *
 * The PNG files themselves sit in the OS-managed cache directory (see
 * storage.writeOverlayPng) under a name that carries the same three parts, so
 * a relaunch — where this map starts empty — finds them again without
 * rendering (#269: a 200 MB sheet must not cost a render per launch). The OS
 * may reclaim that directory at any time; both lookups verify the file.
 */
const rasterCache = new Map<string, string>();
// Active-set changes share work, but a replacement provider must not inherit
// an unresolved request owned by an engine that has already unmounted.
const pendingRastersByProvider = new WeakMap<
  ReturnType<typeof usePdfRasterizer>,
  Map<string, Promise<string>>
>();

function rasterCacheKey(docId: string, pageIndex: number, revision: string): string {
  return `${docId}:${revision}:${pageIndex}:${OVERLAY_TARGET_WIDTH_PX}`;
}

/** The on-disk name of a page's raster (without extension). */
function rasterFileName(docId: string, pageIndex: number, revision: string): string {
  return `${docId}_${revision}_${pageIndex}_${OVERLAY_TARGET_WIDTH_PX}`;
}

/**
 * The CRS string a skipped page is reported under. `sourceCrs` is only present
 * on documents parsed since #243; older ones fall back to the EPSG code, then
 * to "unknown CRS" — which is itself the signal that the map predates the fix
 * and must be re-imported.
 */
export function describeSourceCrs(geo: GeoReference): string {
  if (geo.sourceCrs) return geo.sourceCrs;
  if (geo.sourceEpsg !== undefined) return `EPSG:${geo.sourceEpsg}`;
  return 'unknown CRS';
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
    // Imported PDFs have unique filenames. Ignore the container prefix, which
    // can rotate on iOS without changing the actual document.
    const revision = `${m.importedAt}_${fnv1a32(m.fileUri.slice(m.fileUri.lastIndexOf('/') + 1))}`;
    for (const pageIndex of new Set(m.activePages)) {
      // The PRIMARY viewport, not the first one listed: AUSTopo sheets put a
      // whole-of-Australia locator inset ahead of the map, and taking the
      // first georeference draws the sheet stretched across the continent.
      const geo = primaryGeoreferenceForPage(m.georeferences, pageIndex);
      if (geo) targets.push({ docId: m.id, fileUri: m.fileUri, revision, geo });
    }
  }
  return targets;
}

/**
 * A page's raster, from the in-memory cache, then from disk, or `undefined`
 * when it has to be rendered. Both are verified against the filesystem.
 */
function cachedRaster(docId: string, pageIndex: number, revision: string): string | undefined {
  const key = rasterCacheKey(docId, pageIndex, revision);
  // Even an in-memory hit must validate the persisted PNG: an interrupted
  // write from an earlier run must not become a permanently blank overlay.
  const onDisk = storage.existingOverlayPng(rasterFileName(docId, pageIndex, revision));
  if (onDisk !== null) {
    rasterCache.set(key, onDisk);
    return onDisk;
  }
  rasterCache.delete(key);
  return undefined;
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
 *
 * Every page's outcome is also written to the overlay status store, which is
 * what the Library card shows as "Rendering page N…" / "Couldn't render page
 * N: …" (#269) — the snackbar on the map is gone in four seconds, the card
 * line stays until the page renders or is deactivated.
 */
export function usePdfOverlays(maps: MapDocument[], enabled = true): PdfOverlaysState {
  const rasterize = usePdfRasterizer();
  const serverOrigin = usePdfRasterizerServer();
  const setStatus = useOverlayStatusStore((s) => s.setStatus);
  const retainStatuses = useOverlayStatusStore((s) => s.retain);
  const [state, setState] = useState<PdfOverlaysState>({
    overlays: [],
    loading: false,
    error: null,
  });

  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  const targets = enabled ? activeTargets(maps) : [];
  // A stable key over the active set; the effect re-runs only when it changes.
  const key = JSON.stringify(targets);

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
    let pendingRasters = pendingRastersByProvider.get(rasterize);
    if (!pendingRasters) {
      pendingRasters = new Map<string, Promise<string>>();
      pendingRastersByProvider.set(rasterize, pendingRasters);
    }
    // A page that left the active set stops reporting on its card at once.
    retainStatuses(targets.map((t) => overlayStatusKey(t.docId, t.geo.pageIndex)));

    (async () => {
      if (targets.length === 0) {
        if (!cancelled) setState({ overlays: [], loading: false, error: null });
        return;
      }
      setState((s) => ({ ...s, loading: true, error: null }));

      const overlays: PdfOverlay[] = [];
      let firstError: string | null = null;

      // Group by document so, on the bridge fallback, a multi-MB PDF is
      // base64-read at most once per batch — and not at all when every one of
      // its pages hits the cache. (The served path reads nothing here.)
      const byDoc = new Map<string, Target[]>();
      const cached = new Set(
        targets.filter((t) => cachedRaster(t.docId, t.geo.pageIndex, t.revision) !== undefined),
      );
      // Publish disk hits before waiting on any cold PDF, but preserve the
      // library stacking order when publishing the resulting overlays.
      for (const t of [
        ...targets.filter((t) => cached.has(t)),
        ...targets.filter((t) => !cached.has(t)),
      ]) {
        const group = `${cached.has(t) ? 'cached' : 'cold'}:${t.docId}`;
        const list = byDoc.get(group);
        if (list) list.push(t);
        else byDoc.set(group, [t]);
      }
      const stackingOrder = new Map(
        targets.map((t, index) => [`${t.docId}:${t.geo.pageIndex}`, index]),
      );

      for (const docTargets of byDoc.values()) {
        // Read lazily, only when some page of this document misses the cache
        // AND has to take the bridge.
        let base64: string | null = null;
        for (const t of docTargets) {
          const { geo } = t;
          const statusKey = overlayStatusKey(t.docId, geo.pageIndex);
          try {
            const pageRect = { x0: 0, y0: 0, x1: geo.pageWidthPt, y1: geo.pageHeightPt };
            const corners = extrapolatePageCorners(
              geo.viewport.rect,
              geo.viewport.corners,
              pageRect,
            );
            const bbox = bboxFromCorners(corners);
            const unprojected = !cornersAreValid(corners);
            if (unprojected || isDegenerateBBox(bbox)) {
              // NOT a silent skip. Every CanTopo sheet landed here — its UTM
              // metres never became lon/lat — and nothing reached the user or a
              // report, so 2,234 sheets were undrawable and invisible about it
              // (#243). Name the CRS: it is what identifies the next
              // unsupported source.
              const crs = describeSourceCrs(geo);
              reportError(
                new Error(
                  `Unplaceable georeference on page ${geo.pageIndex + 1} (${crs}): ` +
                    `${unprojected ? 'corners are not lon/lat' : 'degenerate extent'} ` +
                    `${JSON.stringify(corners.topLeft)}..${JSON.stringify(corners.bottomRight)}`,
                ),
                'pdf-overlay-georeference',
              );
              // Corners outside lon/lat range mean the CRS never resolved; a
              // degenerate-but-valid extent is a different (rarer) fault, and
              // keeps its own wording rather than blaming the projection.
              const reason = unprojected
                ? unsupportedProjectionNotice(geo.sourceCrs)
                : `Page ${geo.pageIndex + 1} has invalid georeferencing — skipped`;
              firstError ??= reason;
              if (!cancelled) setStatus(statusKey, { phase: 'failed', reason });
              continue;
            }
            // The raster is geo-independent (the whole page at a fixed width),
            // so a cached PNG stays valid even if the georeference changes;
            // only the corners above are recomputed.
            let imageUri = cachedRaster(t.docId, geo.pageIndex, t.revision);
            if (!imageUri) {
              if (!cancelled) setStatus(statusKey, { phase: 'rendering' });
              // Served over loopback when the engine has a server; the bridge
              // only for small files without one; a clear refusal otherwise —
              // never a 45 s hang on a file that was always going to OOM.
              const cacheKey = rasterCacheKey(t.docId, geo.pageIndex, t.revision);
              let pending = pendingRasters.get(cacheKey);
              if (!pending) {
                pending = (async () => {
                  const origin = await serverOrigin();
                  if (!enabledRef.current) throw new Error('PDF overlays are hidden');
                  const choice = chooseRasterSource({
                    origin,
                    documentPath: storage.toDocumentPath(t.fileUri),
                    sizeBytes: storage.fileSizeAt(t.fileUri),
                  });
                  if (choice.kind === 'unrenderable') throw new Error(choice.reason);
                  let source: RasterizeSource;
                  if (choice.kind === 'url') {
                    source = { url: choice.url };
                  } else {
                    base64 ??= await storage.readFileBase64(t.fileUri);
                    source = { base64 };
                  }
                  if (!enabledRef.current) throw new Error('PDF overlays are hidden');
                  const startedAt = Date.now();
                  const raster = await rasterize({
                    source,
                    pageIndex: geo.pageIndex,
                    targetWidthPx: OVERLAY_TARGET_WIDTH_PX,
                    nativePage: {
                      fileUri: storage.resolveDocumentPath(t.fileUri),
                      revision: t.revision,
                      expectedPageWidthPt: geo.pageWidthPt,
                      expectedPageHeightPt: geo.pageHeightPt,
                    },
                  });
                  console.log(
                    `PdfOverlay: ${t.docId} page ${geo.pageIndex + 1} rasterized via ${choice.kind} ` +
                      `in ${Date.now() - startedAt} ms (open ${raster.loadMs} ms, render ${raster.renderMs} ms, ` +
                      `${raster.widthPx}x${raster.heightPx})`,
                  );
                  // MapLibre's ImageSource needs a file:// url, not a data: URI — write
                  // the rasterized PNG to the cache and reference it by file path.
                  // Done even if this run was superseded: the raster is still
                  // valid, and the next run finds it in the cache instead of
                  // paying for the render twice.
                  const name = rasterFileName(t.docId, geo.pageIndex, t.revision);
                  const renderedUri =
                    raster.fileUri !== undefined
                      ? storage.adoptOverlayPng(name, raster.fileUri)
                      : storage.writeOverlayPng(
                          name,
                          raster.pngDataUri.replace(/^data:image\/png;base64,/, ''),
                        );
                  rasterCache.set(rasterCacheKey(t.docId, geo.pageIndex, t.revision), renderedUri);
                  return renderedUri;
                })().finally(() => pendingRasters.delete(cacheKey));
                pendingRasters.set(cacheKey, pending);
              }
              imageUri = await pending;
              if (cancelled) return;
            }
            setStatus(statusKey, { phase: 'rendered' });
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
            overlays.sort(
              (a, b) => (stackingOrder.get(a.id) ?? 0) - (stackingOrder.get(b.id) ?? 0),
            );
            // Do not hold ready maps behind another document's slow render.
            if (!cancelled) setState({ overlays: [...overlays], loading: true, error: firstError });
          } catch (err) {
            if (cancelled) return;
            reportError(err, 'pdf-overlay-render');
            const reason = err instanceof Error ? err.message : 'Failed to render a PDF page';
            firstError ??= reason;
            setStatus(statusKey, { phase: 'failed', reason });
          }
        }
      }

      if (!cancelled) setState({ overlays, loading: false, error: firstError });
    })();

    return () => {
      cancelled = true;
    };
    // rasterize/serverOrigin/store setters are stable; `key` captures the targets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}
