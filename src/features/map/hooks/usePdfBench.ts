import type { PdfOverlay } from '@features/map/usePdfOverlay';
import { usePdfRasterizer, usePdfRasterizerServer } from '@features/map/PdfRasterizer';
import { nativePageGeometry } from '@core/geo/geopdf/pageBox';
import { primaryGeoreferenceForPage } from '@core/geo/geopdf/primary';
import { servedFileUrl } from '@core/storage/servedPaths';
import { mapDocumentFromStoredPdf } from '@features/library/importMap';
import * as storage from '@data/storage';
import { readQaCommand } from '@data/qaReports';
import {
  PDF_BENCH,
  PDF_BENCH_JS_START,
  pdfBenchLastDetails,
  pdfBenchSubscribe,
  type PdfBenchEvent,
} from '@lib/pdfBenchProbe';
import type { CameraRef } from '@maplibre/maplibre-react-native';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { Directory, File, Paths } from 'expo-file-system';
import * as Linking from 'expo-linking';
import { useEffect, useRef, type RefObject } from 'react';
import { useWindowDimensions } from 'react-native';
import { planSteps, type Bounds } from './pdfBenchPlan';
import { keepAlive } from '@data/keepAlive';

/**
 * PDF time-to-sharp benchmark — compiled in only with `EXPO_PUBLIC_PDF_BENCH=1`
 * (a local perf build), inert otherwise. A host script opens
 *
 *   inukshuk://?pbench=<url of a plan JSON on the host>
 *
 * The plan names the PDFs (host URLs) and the camera script. For each PDF the
 * harness empties the library, imports it, and walks the steps: move the
 * camera (no animation), then time until the visible area is at full quality:
 * the page's overview is on the map, every visible detail tile (or a sharper
 * stand-in) is published, and MapLibre has drawn a frame after that. Results,
 * the new tile PNGs (for the quality check) and screenshots go to the host.
 */

interface PlanMap {
  slug: string;
  url: string;
}
interface Plan {
  runId: string;
  host: string;
  maps: PlanMap[];
  /** Zoom offsets above "whole sheet" for the jump scenario. */
  zoomOffsets: number[];
  jumpsPerZoom: number;
  walk: boolean;
  jumps: boolean;
  uploadTiles: boolean;
  shots: boolean;
  /** Most time to wait for one step to be sharp. */
  timeoutMs: number;
  /** Most time to wait for background work (the neighbour ring) before the next step. */
  quietMs: number;
  seed: number;
  /** Optional: raster edge sizes (px) to time single crops at, native and pdf.js. */
  probeSizes?: number[];
  /** Optional: skip the camera steps (probe only). */
  probeOnly?: boolean;
}

interface Probe {
  bounds: string;
  overlays: PdfOverlay[];
  details: PdfOverlay[];
  commits: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function usePdfBench(args: {
  cameraRef: RefObject<CameraRef | null>;
  settledBounds: Bounds | null;
  overlays: PdfOverlay[];
  details: PdfOverlay[];
  renderedFramesRef: RefObject<number>;
  /** Every frame MapLibre draws (bench builds count them). */
  framesRef: RefObject<number>;
}): void {
  const window = useWindowDimensions();
  const rasterize = usePdfRasterizer();
  const serverOrigin = usePdfRasterizerServer();
  const probe = useRef<Probe>({ bounds: '', overlays: [], details: [], commits: 0 });
  // Mirror the props into a ref every commit: the runner reads it in a loop.
  useEffect(() => {
    if (!PDF_BENCH) return;
    const p = probe.current;
    p.bounds = args.settledBounds ? JSON.stringify(args.settledBounds) : '';
    p.overlays = args.overlays;
    p.details = args.details;
    p.commits += 1;
  });
  const sizeRef = useRef({ w: window.width, h: window.height, scale: window.scale });
  useEffect(() => {
    sizeRef.current = { w: window.width, h: window.height, scale: window.scale };
  }, [window.width, window.height, window.scale]);
  const { cameraRef, renderedFramesRef, framesRef } = args;

  useEffect(() => {
    if (!PDF_BENCH) return;
    let running = false;
    const handle = (url: string | null) => {
      if (!url || running) return;
      const { queryParams } = Linking.parse(url);
      const planUrl = queryParams?.pbench;
      if (typeof planUrl !== 'string') return;
      running = true;
      const open = queryParams?.open;
      const t0 = Number(queryParams?.t0);
      void (typeof open === 'string' ? runOpen(planUrl, open, t0) : run(planUrl)).finally(() => {
        running = false;
      });
    };

    /**
     * Cold launch: the host force-stopped the app and started it again with
     * this link (`open=<slug>`, `t0` = device ms just before the launch).
     * Times the map's first view, wherever the camera came up (the map
     * starts at z14 on the device's location), until it is sharp.
     */
    const runOpen = async (planUrl: string, slug: string, t0: number) => {
      const plan = (await (await fetch(planUrl)).json()) as Plan;
      const doc = useLibraryStore.getState().maps.find((m) => m.name === slug);
      const result: Record<string, unknown> = {
        runId: plan.runId,
        map: slug,
        kind: 'open',
        jsStartMs: Number.isFinite(t0) ? PDF_BENCH_JS_START - t0 : null,
      };
      if (doc) {
        let tSharp = 0;
        let tFirstSettle = 0;
        const from = Date.now();
        while (!tSharp && Date.now() - from < plan.timeoutMs) {
          await sleep(16);
          const p = probe.current;
          if (!p.bounds) continue;
          if (!tFirstSettle) tFirstSettle = Date.now();
          const overview = p.overlays.some((o) => o.id.startsWith(`${doc.id}:`) && o.imageUri);
          const d = pdfBenchLastDetails();
          if (!overview || !d || d.bounds !== p.bounds || d.covered < d.visible) continue;
          const want = [...d.shown].sort().join('|');
          const shownNow = () =>
            probe.current.details
              .filter((o) => o.id.startsWith(`${doc.id}:`))
              .map((o) => o.imageUri)
              .sort()
              .join('|');
          const waitFrom = Date.now();
          while (shownNow() !== want && Date.now() - waitFrom < 2000) await sleep(8);
          const full = renderedFramesRef.current ?? 0;
          const plain = framesRef.current ?? 0;
          const frameFrom = Date.now();
          while (Date.now() - frameFrom < 1500) {
            if ((renderedFramesRef.current ?? 0) > full || (framesRef.current ?? 0) >= plain + 3)
              break;
            await sleep(4);
          }
          tSharp = Date.now();
          result.visibleTiles = d.visible;
          result.bounds = p.bounds;
        }
        result.sharpMs = tSharp && Number.isFinite(t0) ? tSharp - t0 : null;
        result.sharpFromJsMs = tSharp ? tSharp - PDF_BENCH_JS_START : null;
        result.firstSettleFromJsMs = tFirstSettle ? tFirstSettle - PDF_BENCH_JS_START : null;
        result.timedOut = !tSharp;
      } else result.error = 'map not in library';
      console.log(`PDF_BENCH open ${JSON.stringify(result)}`);
      await fetch(`${plan.host}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      }).catch(() => undefined);
      await fetch(`${plan.host}/done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: plan.runId }),
      }).catch(() => undefined);
    };

    const run = async (planUrl: string) => {
      const plan = (await (await fetch(planUrl)).json()) as Plan;
      const post = (path: string, body: unknown) =>
        fetch(`${plan.host}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).catch(() => undefined);
      const log = (msg: string) => {
        console.log(`PDF_BENCH ${msg}`);
        void post('/log', { runId: plan.runId, msg });
      };
      // Raster requests, as the probe reports them.
      const inflight = new Map<number, Extract<PdfBenchEvent, { kind: 'raster-start' }>>();
      let rasters: (PdfBenchEvent & { kind: 'raster-end' })[] = [];
      let lastDetails: Extract<PdfBenchEvent, { kind: 'details' }> | null = null;
      const unsubscribe = pdfBenchSubscribe((e) => {
        if (e.kind === 'raster-start') inflight.set(e.id, e);
        else if (e.kind === 'raster-end') {
          const start = inflight.get(e.id);
          inflight.delete(e.id);
          rasters.push({ ...e, error: e.error, ...(start ? { priority: start.priority } : {}) });
        } else lastDetails = e;
      });
      try {
        useMapStore.getState().setFollowUser(false);
        const settings = useSettingsStore.getState();
        if (!settings.showPdfOverlay) settings.set('showPdfOverlay', true);
        for (const target of plan.maps) {
          const lib = useLibraryStore.getState();
          for (const m of [...lib.maps]) lib.removeMap(m.id);
          await sleep(500);
          const t0 = Date.now();
          const id = storage.newId();
          const dir = new Directory(Paths.cache, 'pdf-bench');
          if (!dir.exists) dir.create({ intermediates: true });
          const dl = new File(dir, `${id}.pdf`);
          await File.downloadFileAsync(target.url, dl, { idempotent: true });
          const tDownloaded = Date.now();
          const fileUri = await storage.importPdf(dl.uri, id);
          dl.delete();
          const doc = await mapDocumentFromStoredPdf(id, fileUri, target.slug);
          const tParsed = Date.now();
          if (doc.georeferences.length === 0) {
            log(`${target.slug} has no georeference`);
            continue;
          }
          rasters = [];
          const tAdded = Date.now();
          useLibraryStore.getState().addMap(doc);
          // Wait for the page's placement (an overview id) to learn its extent.
          let sheet: Bounds | null = null;
          for (let i = 0; i < 600 && !sheet; i++) {
            await sleep(100);
            const o = probe.current.overlays.find((x) => x.id.startsWith(`${id}:`));
            if (o)
              sheet = {
                west: o.bbox.minLng,
                south: o.bbox.minLat,
                east: o.bbox.maxLng,
                north: o.bbox.maxLat,
              };
          }
          if (!sheet) {
            log(`${target.slug} never placed`);
            continue;
          }
          const tPlaced = Date.now();
          if (plan.probeSizes?.length) {
            // Cost of ONE crop as a function of its size, per backend: what
            // a tile costs, and what one bigger crop instead of many costs.
            const geo = primaryGeoreferenceForPage(doc.georeferences, doc.activePages[0] ?? 0);
            const origin = await serverOrigin();
            const url = origin ? servedFileUrl(origin, storage.toDocumentPath(fileUri)) : null;
            const native = geo ? nativePageGeometry(geo) : null;
            if (geo && url) {
              for (const backend of ['native', 'pdfjs'] as const) {
                if (backend === 'native' && !native) continue;
                for (const size of plan.probeSizes) {
                  for (let rep = 0; rep < 3; rep++) {
                    // A crop near the page corner whose raster is `size` px
                    // wide at ~4x the page's point size, shifted per rep.
                    const fw = Math.min(0.9, size / (geo.pageWidthPt * 4));
                    const fh = Math.min(0.9, fw * (geo.pageWidthPt / geo.pageHeightPt) * 0.8);
                    const x0 = 0.05 + rep * 0.01;
                    const y0 = 0.05 + rep * 0.01;
                    const t = Date.now();
                    try {
                      const r = await rasterize({
                        source: { url },
                        pageIndex: geo.pageIndex,
                        targetWidthPx: size,
                        crop: { x0, y0, x1: x0 + fw, y1: y0 + fh },
                        // (as object: older trees, bisected with this file, lack holdKey)
                        ...(backend === 'pdfjs' ? ({ holdKey: `probe-${id}` } as object) : {}),
                        nativePage:
                          backend === 'native' && native
                            ? {
                                fileUri: storage.resolveDocumentPath(fileUri),
                                revision: String(doc.importedAt),
                                ...native,
                              }
                            : null,
                      });
                      if (r.fileUri) storage.deleteFileAt(r.fileUri);
                      void post('/result', {
                        runId: plan.runId,
                        map: target.slug,
                        kind: 'probe',
                        backend,
                        size,
                        rep,
                        ms: Date.now() - t,
                        loadMs: r.loadMs,
                        renderMs: r.renderMs,
                        w: r.widthPx,
                        h: r.heightPx,
                        path: r.fileUri ? 'file' : 'data',
                      });
                    } catch (e) {
                      void post('/result', {
                        runId: plan.runId,
                        map: target.slug,
                        kind: 'probe',
                        backend,
                        size,
                        rep,
                        error: String(e),
                      });
                    }
                  }
                }
              }
            }
            log(`${target.slug} probe done`);
            if (plan.probeOnly) continue;
          }
          // Jumps land inside the map frame, not in the page's blank collar (#637).
          const frameGeo = primaryGeoreferenceForPage(doc.georeferences, doc.activePages[0] ?? 0);
          const frame: Bounds | undefined = frameGeo && {
            west: frameGeo.bbox.minLng,
            south: frameGeo.bbox.minLat,
            east: frameGeo.bbox.maxLng,
            north: frameGeo.bbox.maxLat,
          };
          const steps = planSteps(plan, sheet, sizeRef.current.w, sizeRef.current.h, frame);
          void post('/result', {
            runId: plan.runId,
            map: target.slug,
            kind: 'import',
            downloadMs: tDownloaded - t0,
            parseMs: tParsed - tDownloaded,
            pages: doc.georeferences.length,
            // Import to the page's overview on the map (first render, cold).
            overviewMs: tPlaced - tAdded,
            sheet,
            window: sizeRef.current,
          });
          const uploaded = new Set<string>();
          for (const step of steps) {
            // Background work (the ring) left over from the last step.
            const quietFrom = Date.now();
            while (inflight.size > 0 && Date.now() - quietFrom < plan.quietMs) await sleep(50);
            const busyAtStart = inflight.size;
            rasters = [];
            const before = probe.current.bounds;
            const shownBefore = probe.current.details
              .filter((o) => o.id.startsWith(`${id}:`))
              .map((o) => o.imageUri)
              .sort()
              .join('|');
            let sharpVia = '';
            const tMove = Date.now();
            await cameraRef.current?.setStop({
              center: step.center,
              zoom: step.zoom,
              pitch: 0,
              bearing: 0,
              duration: 0,
            });
            // Settled: the map reported new bounds (or there was nothing to move).
            let tSettled = 0;
            let tCovered = 0;
            let tSharp = 0;
            let timedOut = false;
            let settledBounds = '';
            while (!tSharp) {
              await sleep(16);
              const now = Date.now();
              if (now - tMove > plan.timeoutMs) {
                timedOut = true;
                break;
              }
              const p = probe.current;
              if (!tSettled) {
                if (p.bounds && (p.bounds !== before || now - tMove > 1500)) {
                  tSettled = now;
                  settledBounds = p.bounds;
                } else continue;
              }
              if (!tCovered) {
                const overview = p.overlays.some((o) => o.id.startsWith(`${id}:`) && o.imageUri);
                const d = lastDetails as Extract<PdfBenchEvent, { kind: 'details' }> | null;
                if (overview && d && d.bounds === settledBounds && d.covered >= d.visible) {
                  tCovered = now;
                  // On screen: the published set has reached the map (a React
                  // commit), and MapLibre drew a frame if anything changed.
                  const want = [...d.shown].sort().join('|');
                  const shownNow = () =>
                    probe.current.details
                      .filter((o) => o.id.startsWith(`${id}:`))
                      .map((o) => o.imageUri)
                      .sort()
                      .join('|');
                  const changed = want !== shownBefore;
                  const waitFrom = Date.now();
                  while (shownNow() !== want && Date.now() - waitFrom < 2000) await sleep(8);
                  // A fully rendered frame (every source, the new images too)
                  // after the commit; offline, failing basemap tiles can keep
                  // MapLibre from ever calling a frame "fully" rendered, so a
                  // plain frame 3 frames later is the fallback.
                  const full = renderedFramesRef.current ?? 0;
                  const plain = framesRef.current ?? 0;
                  const frameFrom = Date.now();
                  sharpVia = changed ? 'cap' : 'unchanged';
                  while (changed && Date.now() - frameFrom < 1500) {
                    if ((renderedFramesRef.current ?? 0) > full) {
                      sharpVia = 'fully';
                      break;
                    }
                    if ((framesRef.current ?? 0) >= plain + 3) {
                      sharpVia = 'frames';
                      break;
                    }
                    await sleep(4);
                  }
                  tSharp = Date.now();
                }
              }
            }
            const d = lastDetails as Extract<PdfBenchEvent, { kind: 'details' }> | null;
            // Delivered resolution at the view centre: raster pixels per
            // device pixel of the raster drawn there (>= 1 is full density).
            let density: number | null = null;
            try {
              const view = JSON.parse(settledBounds || probe.current.bounds) as Bounds;
              const screenPx = sizeRef.current.w * Math.min(sizeRef.current.scale, 3);
              const viewSpan = view.east - view.west;
              const cx = (view.east + view.west) / 2,
                cy = (view.north + view.south) / 2;
              const contains = (o: PdfOverlay) =>
                o.bbox.minLng <= cx &&
                o.bbox.maxLng >= cx &&
                o.bbox.minLat <= cy &&
                o.bbox.maxLat >= cy;
              const ratios: number[] = [];
              for (const o of probe.current.details) {
                const m = /:tile:\d+:\d+:\d+:(\d+)(?::(\d+)x\d+)?$/.exec(o.id);
                if (!m || !o.id.startsWith(`${id}:`) || !contains(o)) continue;
                const rasterW = Number(m[1]) * Number(m[2] ?? 1);
                const onScreen = ((o.bbox.maxLng - o.bbox.minLng) / viewSpan) * screenPx;
                ratios.push(rasterW / onScreen);
              }
              const planned = (lastDetails as Extract<PdfBenchEvent, { kind: 'details' }> | null)
                ?.resolution;
              if (planned !== undefined && Number.isFinite(planned)) density = planned;
              else if (ratios.length) density = Math.max(...ratios);
              else {
                const o = probe.current.overlays.find((x) => x.id.startsWith(`${id}:`));
                if (o) density = 2048 / (((o.bbox.maxLng - o.bbox.minLng) / viewSpan) * screenPx);
              }
            } catch {
              density = null;
            }
            const result = {
              runId: plan.runId,
              density: density === null ? null : Math.round(density * 100) / 100,
              map: target.slug,
              kind: 'step',
              step: step.name,
              stepKind: step.kind,
              level: step.level,
              zoom: step.zoom,
              center: step.center,
              settleMs: tSettled ? tSettled - tMove : null,
              coveredMs: tCovered ? tCovered - tMove : null,
              sharpMs: tSharp ? tSharp - tMove : null,
              timedOut,
              sharpVia,
              busyAtStart,
              visibleTiles: d?.visible ?? 0,
              coveredTiles: d?.covered ?? 0,
              rasters: rasters.map((r) => ({
                ok: r.ok,
                ms: r.ms,
                path: r.path,
                loadMs: r.loadMs,
                renderMs: r.renderMs,
                w: r.widthPx,
                h: r.heightPx,
                at: r.at - tMove,
                priority: (r as { priority?: string }).priority,
                error: r.error,
              })),
            };
            log(
              `${target.slug} ${step.name} sharp ${result.sharpMs ?? 'TIMEOUT'} ms ` +
                `(settle ${result.settleMs}, tiles ${result.coveredTiles}/${result.visibleTiles}, ` +
                `renders ${rasters.length})`,
            );
            await post('/result', result);
            if (plan.shots) {
              await fetch(
                `${plan.host}/shot?run=${encodeURIComponent(plan.runId)}&map=${encodeURIComponent(
                  target.slug,
                )}&step=${encodeURIComponent(step.name)}`,
              ).catch(() => undefined);
            }
            if (plan.uploadTiles) {
              const shown = [...probe.current.details, ...probe.current.overlays].filter(
                (o) => o.id.startsWith(`${id}:`) && !uploaded.has(o.imageUri),
              );
              for (const o of shown) {
                uploaded.add(o.imageUri);
                let png64 = '';
                try {
                  const tile = new File(o.imageUri);
                  png64 = await keepAlive(tile, tile.base64());
                } catch (e) {
                  log(`tile unreadable ${o.imageUri}: ${String(e)}`);
                  continue;
                }
                await fetch(
                  `${plan.host}/tile?run=${encodeURIComponent(plan.runId)}&map=${encodeURIComponent(
                    target.slug,
                  )}&step=${encodeURIComponent(step.name)}&id=${encodeURIComponent(o.id)}`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: o.id, coordinates: o.coordinates, png64 }),
                  },
                ).catch(() => undefined);
              }
            }
          }
        }
        log('done');
        void post('/done', { runId: plan.runId });
      } catch (e) {
        log(`failed ${String(e)}`);
        void post('/done', { runId: plan.runId, error: String(e) });
      } finally {
        unsubscribe();
      }
    };

    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    // The same link through a file (iOS simulator: `simctl openurl` asks
    // "Open in …?" every time): <documents>/qa/command.txt.
    let last: string | null = readQaCommand();
    const poll = setInterval(() => {
      const cmd = readQaCommand();
      if (cmd !== null && cmd !== last) {
        last = cmd;
        handle(cmd.trim());
      }
    }, 300);
    return () => {
      sub.remove();
      clearInterval(poll);
    };
  }, [cameraRef, renderedFramesRef, framesRef, rasterize, serverOrigin]);
}
