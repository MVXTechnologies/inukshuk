import { isPerformedActivity } from '@core/dashboard/aggregate';
import { parseGpx } from '@core/geo/gpx';
import { scanGpxActivity } from '@core/geo/gpx/scanActivity';
import type { TrackPoint, TrackSummary } from '@core/models';
import {
  isTrailStatsSummary,
  summarizeTrail,
  trailStatsKey,
  TRAIL_STATS_VERSION,
  type TrailStatsSummary,
} from '@core/stats/trailSummary';

import * as storage from './storage';

/**
 * The cached per-trail statistics (Logbook statistics): best efforts and
 * heart-rate histograms, computed ONCE per trail revision and kept in one
 * small JSON file (`<cache>/trail-stats.json`), the way the personal heatmap
 * keeps its tiles (#500/#507).
 *
 * - A trail saved or imported is summarised right away from the points in
 *   hand ({@link primeTrailStats}) — nothing ever parses its GPX back.
 * - {@link TrailStatsStore.sync} brings the cache in step with the library:
 *   trails that went away are dropped, new or edited ones are summarised in
 *   the background, one at a time, yielding to the UI between trails and
 *   writing every {@link BATCH} trails. On a first run with a big library
 *   this is the backfill; the screens show its progress ("Computing…
 *   120/412") and fill in as batches land.
 * - A missing, corrupt or older-version file simply starts empty.
 */

/** Trails summarised between two writes (and two publishes to the screens). */
export const BATCH = 25;

/** How long a primed trail is kept while no synced library list has it yet. */
const FRESH_MS = 10 * 60 * 1000;

interface Entry {
  key: string;
  summary: TrailStatsSummary;
}

interface CacheFile {
  v: number;
  entries: Record<string, { key: string; s: unknown }>;
}

export interface TrailStatsIO {
  read(): Promise<string | null>;
  write(text: string): void;
}

export interface LoadedPoints {
  points: TrackPoint[];
  segmentStarts: number[];
}

export interface TrailStatsClock {
  yieldToUi(): Promise<void>;
}

export interface TrailStatsOptions {
  io: TrailStatsIO;
  loadPoints?: (t: TrackSummary) => Promise<LoadedPoints | null>;
  clock?: TrailStatsClock;
  /** Delay before a primed summary is written (several imports share one write). */
  primeFlushMs?: number;
}

/** Backfill progress: trails summarised out of the trails wanted. */
export interface TrailStatsProgress {
  done: number;
  total: number;
  /** The background loop is working. */
  running: boolean;
}

const realClock: TrailStatsClock = {
  yieldToUi: () => new Promise((r) => setTimeout(r, 0)),
};

/** A trail's points from its GPX: the fast tag scan, else the full parse. Never throws. */
export async function readTrailPoints(t: TrackSummary): Promise<LoadedPoints | null> {
  try {
    const text = await storage.readFileText(t.fileUri);
    const scanned = scanGpxActivity(text);
    if (scanned) return scanned;
    const doc = parseGpx(text);
    return { points: doc.points, segmentStarts: doc.segmentStarts };
  } catch {
    return null;
  }
}

export class TrailStatsStore {
  private readonly io: TrailStatsIO;
  private readonly loadPoints: (t: TrackSummary) => Promise<LoadedPoints | null>;
  private readonly clock: TrailStatsClock;
  private readonly primeFlushMs: number;

  private entries = new Map<string, Entry>();
  private publishedMap: ReadonlyMap<string, TrailStatsSummary> = new Map();
  private progressValue: TrailStatsProgress = { done: 0, total: 0, running: false };
  private stampValue = 0;
  private readonly listeners = new Set<() => void>();

  private opening: Promise<void> | null = null;
  private wanted: TrackSummary[] | null = null;
  private wantedChanged = false;
  /**
   * Primed trails not yet seen in a synced list → when primed: a sync that
   * lags the library must not drop them (an import that never landed is
   * dropped once {@link FRESH_MS} has passed).
   */
  private readonly fresh = new Map<string, number>();
  private running: Promise<void> | null = null;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Counters (tests and the bench). */
  readonly stats = { computed: 0, writes: 0, loads: 0 };

  constructor(options: TrailStatsOptions) {
    this.io = options.io;
    this.loadPoints = options.loadPoints ?? readTrailPoints;
    this.clock = options.clock ?? realClock;
    this.primeFlushMs = options.primeFlushMs ?? 1500;
  }

  // ---- reading -------------------------------------------------------------

  /** Changes whenever the published summaries or the progress do. */
  get stamp(): number {
    return this.stampValue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Trail id → summary, as of the last published batch. Same object until it changes. */
  summaries(): ReadonlyMap<string, TrailStatsSummary> {
    return this.publishedMap;
  }

  progress(): TrailStatsProgress {
    return this.progressValue;
  }

  // ---- writing -------------------------------------------------------------

  /**
   * Keep the cache in step with the library: the performed trails among
   * `tracks` are summarised (in the background) unless already cached at
   * their current revision; cached trails no longer listed are dropped.
   */
  sync(tracks: readonly TrackSummary[]): void {
    this.wanted = tracks.filter(isPerformedActivity);
    this.wantedChanged = true;
    this.kick();
  }

  /** Summarise a trail from the points in hand (a save or import). Never throws. */
  prime(
    t: Pick<TrackSummary, 'id' | 'endedAt'> & {
      stats: Pick<TrackSummary['stats'], 'pointCount' | 'distanceM'>;
    },
    points: readonly TrackPoint[],
    segmentStarts: readonly number[] = [],
  ): void {
    try {
      this.entries.set(t.id, {
        key: trailStatsKey(t),
        summary: summarizeTrail(points, segmentStarts),
      });
      this.fresh.set(t.id, Date.now());
      this.stats.computed++;
      this.dirty = true;
      this.publish();
      this.scheduleFlush();
    } catch {
      // An optimisation: the next sync computes it from the GPX instead.
    }
  }

  /** Resolves once the background loop has nothing left to do. */
  async whenIdle(): Promise<void> {
    await this.open();
    while (this.running) await this.running;
  }

  /** Write now whatever is pending (tests; app backgrounding). */
  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    const file: CacheFile = { v: TRAIL_STATS_VERSION, entries: {} };
    for (const [id, e] of this.entries) file.entries[id] = { key: e.key, s: e.summary };
    try {
      this.io.write(JSON.stringify(file));
      this.stats.writes++;
      this.dirty = false;
    } catch {
      // Disk full or similar: the summaries stay in memory and the next
      // batch tries again; nothing is lost but the persisted copy.
    }
  }

  // ---- internals -----------------------------------------------------------

  private open(): Promise<void> {
    this.opening ??= (async () => {
      let text: string | null = null;
      try {
        text = await this.io.read();
      } catch {
        text = null;
      }
      if (text === null) return;
      try {
        const doc = JSON.parse(text) as Partial<CacheFile>;
        if (doc.v !== TRAIL_STATS_VERSION || typeof doc.entries !== 'object' || !doc.entries) {
          return;
        }
        for (const [id, raw] of Object.entries(doc.entries)) {
          // A trail primed while the file was being read is newer: keep it.
          if (this.entries.has(id)) continue;
          if (raw && typeof raw.key === 'string' && isTrailStatsSummary(raw.s)) {
            this.entries.set(id, { key: raw.key, summary: raw.s });
          }
        }
      } catch {
        // Corrupt: start empty, the loop refills it.
      }
      this.publish();
    })();
    return this.opening;
  }

  private kick(): void {
    if (this.running) return;
    this.running = this.loop().finally(() => {
      this.running = null;
      // A sync that arrived as the loop was finishing.
      if (this.wantedChanged) this.kick();
    });
  }

  private async loop(): Promise<void> {
    await this.open();
    while (this.wantedChanged && this.wanted) {
      this.wantedChanged = false;
      const wanted = this.wanted;
      const ids = new Set(wanted.map((t) => t.id));
      for (const id of ids) this.fresh.delete(id);
      const freshFloor = Date.now() - FRESH_MS;
      for (const id of [...this.entries.keys()]) {
        const primedAt = this.fresh.get(id);
        if (!ids.has(id) && (primedAt === undefined || primedAt < freshFloor)) {
          this.fresh.delete(id);
          this.entries.delete(id);
          this.dirty = true;
        }
      }
      // Newest first: the trails the screens show first are summarised first.
      const todo = wanted
        .filter((t) => this.entries.get(t.id)?.key !== trailStatsKey(t))
        .sort((a, b) => b.startedAt - a.startedAt);
      const total = wanted.length;
      let done = total - todo.length;
      this.setProgress({ done, total, running: todo.length > 0 });
      let sinceFlush = 0;
      for (const t of todo) {
        if (this.wantedChanged) break;
        await this.clock.yieldToUi();
        // Primed (or re-synced) meanwhile.
        if (this.entries.get(t.id)?.key === trailStatsKey(t)) {
          done++;
          continue;
        }
        this.stats.loads++;
        const loaded = await this.loadPoints(t);
        // Reading and summarising are each a few frames' work on a phone:
        // give the UI a turn between them too.
        await this.clock.yieldToUi();
        const summary = summarizeTrail(loaded?.points ?? [], loaded?.segmentStarts ?? []);
        this.entries.set(t.id, { key: trailStatsKey(t), summary });
        this.stats.computed++;
        this.dirty = true;
        done++;
        sinceFlush++;
        if (sinceFlush >= BATCH) {
          sinceFlush = 0;
          this.flush();
          this.publish();
        }
        this.setProgress({ done, total, running: true });
      }
      this.flush();
      this.publish();
      this.setProgress({ done, total, running: false });
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    const timer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.primeFlushMs);
    // Node (tests) only: a pending write never holds the process open.
    (timer as { unref?: () => void }).unref?.();
    this.flushTimer = timer;
  }

  private publish(): void {
    const next = new Map<string, TrailStatsSummary>();
    for (const [id, e] of this.entries) next.set(id, e.summary);
    this.publishedMap = next;
    this.notify();
  }

  private setProgress(p: TrailStatsProgress): void {
    const cur = this.progressValue;
    if (cur.done === p.done && cur.total === p.total && cur.running === p.running) return;
    this.progressValue = p;
    this.notify();
  }

  private notify(): void {
    this.stampValue++;
    for (const l of this.listeners) l();
  }
}

/** The real, file-backed IO. */
export function createTrailStatsFileIO(): TrailStatsIO {
  return {
    read: () => storage.readTrailStatsCache(),
    write: (text) => storage.writeTrailStatsCache(text),
  };
}

let shared: TrailStatsStore | null = null;

/** The app's trail-statistics store. */
export function getTrailStatsStore(): TrailStatsStore {
  shared ??= new TrailStatsStore({ io: createTrailStatsFileIO() });
  return shared;
}

/** Test hook: replace (or drop, with null) the shared store. */
export function setTrailStatsStoreForTests(store: TrailStatsStore | null): void {
  shared = store;
}

/**
 * Summarise a just-saved or just-imported trail from the points in hand, so
 * Statistics never has to read its GPX back. Best-effort: never throws.
 */
export function primeTrailStats(
  t: Pick<TrackSummary, 'id' | 'endedAt'> & {
    stats: Pick<TrackSummary['stats'], 'pointCount' | 'distanceM'>;
  },
  points: readonly TrackPoint[],
  segmentStarts: readonly number[] = [],
): void {
  try {
    getTrailStatsStore().prime(t, points, segmentStarts);
  } catch {
    // Never in the way of a save.
  }
}
