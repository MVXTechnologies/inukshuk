import {
  ContourRecoveryLog,
  insetRect,
  intersectRect,
  linesCrossRect,
  MAX_CHECKS_PER_PASS,
  MAX_FETCHES_PER_PASS,
  readMvtLines,
  RECOVERY_MIN_ZOOM,
  sourceTileZoom,
  tileBounds,
  tileKey,
  tileScreenBox,
  tilesInBounds,
  tileUrl,
  type ScreenRect,
  type TileContent,
  type TileId,
  type TileLines,
  type TileOnScreen,
} from '@core/map/contourRecovery';
import { tileFetchUrl } from '@data/basemapTiles';
import { useCallback, useEffect, useState } from 'react';

/** The settled camera, as `onRegionDidChange` reports it. */
export interface SettledView {
  /** `[west, south, east, north]`. */
  bounds: readonly [number, number, number, number];
  zoom: number;
  pitch: number;
}

/** The three map calls recovery makes (MapLibre's `MapRef` has them). */
export interface ContourRecoveryMap {
  project(lngLat: [number, number]): Promise<[number, number]>;
  queryRenderedFeatures(
    bounds: [[number, number], [number, number]],
    options: { layers: string[] },
  ): Promise<unknown[]>;
  setSourceVisibility(visible: boolean, source: string): Promise<void>;
}

export interface ContourRecoveryOptions {
  mapRef: { readonly current: ContourRecoveryMap | null };
  /** Contours are on screen, the map is loaded, the app is online and focused. */
  enabled: boolean;
  /** The contour tiles' `{z}/{x}/{y}` URL template — the one the style reads. */
  tilesUrl: string;
  /** The style's contour source, its zoom range, and the line layers drawn from it. */
  sourceId: string;
  minzoom: number;
  maxzoom: number;
  layerIds: readonly string[];
  /** The map view's size in the pixels `project` answers in. */
  viewSize: () => { width: number; height: number };
  /** A tile's bytes; rejects on an HTTP error. Injected by the tests. */
  fetchTile?: (url: string) => Promise<Uint8Array>;
  now?: () => number;
}

/** After the camera settles: time for the map to load what it can first. */
export const SETTLE_DELAY_MS = 2500;
/** After a nudge: time for the map to load the tiles again before looking. */
export const RECHECK_AFTER_NUDGE_MS = 3000;
/** How long the contour layers stay hidden in a nudge (a few frames). */
export const NUDGE_HIDDEN_MS = 150;
const FETCH_TIMEOUT_MS = 15_000;
/** A tilted map is not a similarity: the screen maths below is only for pitch ~0. */
const MAX_PITCH_DEG = 2;
/** Lines of the neighbouring tiles reach a few pixels into a tile (its buffer). */
const TILE_INSET_PX = 12;
/** A line must run this far inside the queried box to count as "should be drawn". */
const LINE_INSET_PX = 6;
/** Smaller than this, a tile's visible part says nothing. */
const MIN_VISIBLE_PX = 48;
/** Half the side of the small box asked first (most tiles have a line through it). */
const PROBE_HALF_PX = 16;
/** Fetched tiles kept while the map has not drawn them yet. */
const MAX_HELD_TILES = 40;

async function fetchTileBytes(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // The template host is the cache key; the request goes where the Worker lives.
    const res = await fetch(tileFetchUrl(url), { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The recovery itself, outside React: nothing it holds is rendered, and a
 * pass must never re-render the map screen.
 */
class ContourRecoverySession {
  private readonly log = new ContourRecoveryLog();
  /** Lines of the tiles fetched and not drawn yet. */
  private readonly held = new Map<string, TileLines>();
  private options: ContourRecoveryOptions | null = null;
  private view: SettledView | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = Infinity;
  private running = false;
  private rerun = false;
  private alive = false;

  setOptions(options: ContourRecoveryOptions): void {
    const wasEnabled = this.options?.enabled === true;
    this.options = options;
    // Switched on (the map finished loading, contours toggled on) with a
    // settled camera already known: look at it.
    if (options.enabled && !wasEnabled && this.view !== null && !this.running) {
      this.schedule(this.now() + SETTLE_DELAY_MS, true);
    }
  }

  start(): void {
    this.alive = true;
  }

  stop(): void {
    this.alive = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = Infinity;
  }

  /** The camera settled: look at the contour tiles in view, in a while. */
  onSettled(view: SettledView): void {
    this.view = view;
    if (this.options?.enabled !== true) return;
    if (this.running) this.rerun = true;
    else this.schedule(this.now() + SETTLE_DELAY_MS, true);
  }

  private now(): number {
    return (this.options?.now ?? Date.now)();
  }

  private get active(): boolean {
    return this.alive && this.options?.enabled === true;
  }

  /**
   * Run a pass at `at` — or sooner, if one is already due sooner; with
   * `restart`, at `at` whatever was due (a new settle starts the wait over).
   */
  private schedule(at: number, restart = false): void {
    if (!this.alive) return;
    if (this.timer !== null) {
      if (!restart && this.timerAt <= at) return;
      clearTimeout(this.timer);
    }
    this.timerAt = at;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.timerAt = Infinity;
        void this.pass();
      },
      Math.max(0, at - this.now()),
    );
  }

  /** Where the tile is on screen, and the box in which to look for its lines. */
  private async locate(
    map: ContourRecoveryMap,
    tile: TileId,
    viewSize: { width: number; height: number },
  ): Promise<{ onScreen: TileOnScreen; box: ScreenRect } | null> {
    const [west, south, east, north] = tileBounds(tile);
    const [topLeft, topRight, bottomLeft] = await Promise.all([
      map.project([west, north]),
      map.project([east, north]),
      map.project([west, south]),
    ]);
    const onScreen = { topLeft, topRight, bottomLeft };
    const visible = intersectRect(tileScreenBox(onScreen), {
      left: 0,
      top: 0,
      right: viewSize.width,
      bottom: viewSize.height,
    });
    const box = visible && insetRect(visible, TILE_INSET_PX);
    if (!box || box.right - box.left < MIN_VISIBLE_PX || box.bottom - box.top < MIN_VISIBLE_PX) {
      return null;
    }
    return { onScreen, box };
  }

  private async draws(
    map: ContourRecoveryMap,
    box: ScreenRect,
    layerIds: readonly string[],
  ): Promise<boolean> {
    const layers = [...layerIds];
    // A small box first: on most tiles it finds a line, and the answer
    // (whole features, over the bridge) stays small.
    const cx = (box.left + box.right) / 2;
    const cy = (box.top + box.bottom) / 2;
    const probe = await map.queryRenderedFeatures(
      [
        [cx - PROBE_HALF_PX, cy - PROBE_HALF_PX],
        [cx + PROBE_HALF_PX, cy + PROBE_HALF_PX],
      ],
      { layers },
    );
    if (probe.length > 0) return true;
    const all = await map.queryRenderedFeatures(
      [
        [box.left, box.top],
        [box.right, box.bottom],
      ],
      { layers },
    );
    return all.length > 0;
  }

  private hold(key: string, lines: TileLines): void {
    this.held.set(key, lines);
    while (this.held.size > MAX_HELD_TILES) {
      const oldest = this.held.keys().next();
      if (oldest.done) break;
      this.held.delete(oldest.value);
      // Without its lines we can no longer tell whether it should draw.
      this.log.settle(oldest.value);
    }
  }

  /** Hide the contour layers for a few frames: MapLibre then asks again for the tiles it lacks. */
  private async nudge(map: ContourRecoveryMap, sourceId: string): Promise<void> {
    try {
      await map.setSourceVisibility(false, sourceId);
      await sleep(NUDGE_HIDDEN_MS);
    } finally {
      // Whatever happened in between, the lines come back.
      await map.setSourceVisibility(true, sourceId);
    }
  }

  private async pass(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      const o = this.options;
      const map = o?.mapRef.current ?? null;
      const view = this.view;
      if (o === null || !this.active || map === null || view === null) return;
      if (view.zoom < RECOVERY_MIN_ZOOM || Math.abs(view.pitch) > MAX_PITCH_DEG) return;
      const z = sourceTileZoom(view.zoom, o.minzoom, o.maxzoom);
      if (z === null) return;
      const { log, held } = this;
      const tiles = tilesInBounds(view.bounds, z)
        .filter((tile) => !log.isSettled(tileKey(tile)))
        .slice(0, MAX_CHECKS_PER_PASS);

      let wake = Infinity;
      let fetches = 0;
      /** Tiles fetched with lines that should be on screen, and are not. */
      const missing: string[] = [];
      for (const tile of tiles) {
        // A newer settle, or recovery switched off: this pass is stale.
        if (!this.active || this.view !== view) break;
        const key = tileKey(tile);
        const where = await this.locate(map, tile, o.viewSize());
        if (where === null) continue;
        if (await this.draws(map, where.box, o.layerIds)) {
          log.settle(key);
          held.delete(key);
          continue;
        }
        if (!log.isReady(key)) {
          if (!log.mayFetch(key, this.now())) {
            const retryAt = log.retryAt(key);
            if (retryAt !== null) wake = Math.min(wake, retryAt);
            continue;
          }
          if (fetches >= MAX_FETCHES_PER_PASS) {
            wake = Math.min(wake, this.now() + SETTLE_DELAY_MS);
            continue;
          }
          fetches++;
          let content: TileContent;
          try {
            const bytes = await (o.fetchTile ?? fetchTileBytes)(tileUrl(o.tilesUrl, tile));
            content = readMvtLines(bytes);
          } catch {
            const retryAt = log.fetchFailed(key, this.now());
            if (retryAt !== null) wake = Math.min(wake, retryAt);
            continue;
          }
          if (content.kind !== 'lines') {
            // Nothing to draw, or nothing we can read: either way, done.
            log.fetchSucceeded(key, false);
            continue;
          }
          log.fetchSucceeded(key, true);
          this.hold(key, content);
        }
        const lines = held.get(key);
        const inner = insetRect(where.box, LINE_INSET_PX);
        // The tile has lines, but none where we look: the map may well have
        // it. It is judged again when another part of it is in view.
        if (lines === undefined || inner === null) continue;
        if (linesCrossRect(lines, where.onScreen, inner)) missing.push(key);
      }

      if (missing.length > 0 && this.active && this.view === view) {
        const keys = log.nudgeable(missing, this.now());
        if (keys.length > 0) {
          log.nudged(keys, this.now());
          await this.nudge(map, o.sourceId);
          wake = Math.min(wake, this.now() + RECHECK_AFTER_NUDGE_MS);
        } else if (missing.some((key) => !log.isSettled(key))) {
          wake = Math.min(wake, log.nextNudgeAt());
        }
      }
      if (wake < Infinity) this.schedule(wake);
    } catch {
      // The map went away mid-pass (unmount, style reload): the next settle starts over.
    } finally {
      this.running = false;
      if (this.rerun) {
        this.rerun = false;
        this.schedule(this.now() + SETTLE_DELAY_MS, true);
      }
    }
  }
}

/**
 * Finds the holes failed contour tiles leave and gets the map to load them
 * again — bounded and polite; the why and the caps are in
 * `@core/map/contourRecovery`.
 *
 * Call the returned function from the camera's settle path. A while later
 * (the map loads what it can first) one pass runs over the contour tiles in
 * view:
 *
 * 1. a tile whose visible part draws contour lines is done;
 * 2. one that draws nothing is fetched from JS (the same URL, so a success
 *    also fills the CDN for the map): an HTTP error is retried after 2 s and
 *    6 s, then left alone; an empty tile is done;
 * 3. if the fetched tile has lines that should be on screen, the map is
 *    nudged: the contour layers are hidden for a few frames and shown again,
 *    which makes MapLibre ask again for exactly the tiles it failed to load
 *    (the ones it has come back from its cache) — at most twice a tile, and
 *    never within 5 s of the last nudge.
 */
export function useContourRecovery(options: ContourRecoveryOptions): (view: SettledView) => void {
  const [session] = useState(() => new ContourRecoverySession());
  useEffect(() => {
    session.setOptions(options);
  });
  useEffect(() => {
    session.start();
    return () => session.stop();
  }, [session]);
  return useCallback((view: SettledView) => session.onSettled(view), [session]);
}
