import { strFromU8 } from 'fflate';

import type { ByteSource } from '@core/geo/geopdf/pdfReader';

import { decodeActivityFile, type DecodedActivity } from './decode';
import {
  ByteBudget,
  DEFAULT_IMPORT_LIMITS,
  ImportLimitError,
  boundedCollector,
  type ImportLimits,
} from './limits';
import { stravaTypeToSport } from './naming';
import { csvFileKey, parseStravaActivitiesCsv, type StravaCsvActivity } from './stravaCsv';
import { listZipEntries, pumpZipEntry, type SourceOpener, type ZipEntry } from './zip';

/**
 * Walk an activity archive — a Strava bulk export (`activities/*.fit.gz|gpx|
 * tcx.gz` + `activities.csv`), a Garmin export (zips nested inside zips:
 * `DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_*.zip` → `.fit`), or any
 * zip of FIT/TCX/GPX files — handing each decoded activity to `onActivity` as
 * soon as it's decoded. Only one entry is decompressed at a time; nested zips
 * are spilled to temporary storage by the host rather than held in memory.
 *
 * Pure: all I/O goes through {@link ArchiveHost}, so the same walker runs over
 * files on device and over in-memory buffers in tests.
 */

/** A temporary file a nested archive is decompressed into. */
export interface ArchiveSpill {
  /** Ref to pass back to {@link ArchiveHost.open}. */
  ref: string;
  write(chunk: Uint8Array): void;
  close(): void;
}

export interface ArchiveHost {
  /** Run `fn` with random access to the archive at `ref` (handle closed after). */
  open<T>(ref: string, fn: (src: ByteSource) => T): T;
  createSpill(): ArchiveSpill;
  /** Delete a spill once its archive has been walked. Must not throw. */
  discardSpill(ref: string): void;
  /** Awaited between entries / slices so the UI stays responsive. */
  yieldToUi(): Promise<void>;
}

export interface WalkProgress {
  /** Activity-file entries finished (decoded or failed). */
  processed: number;
  /** Activity-file entries discovered so far (grows as nested zips open). */
  discovered: number;
}

export interface WalkResult {
  /** Entries that looked like activities but could not be read/decoded. */
  failed: number;
  /** True when a size/entry cap stopped the walk early (remaining entries skipped). */
  limitReached: boolean;
}

const ACTIVITY_RE = /\.(fit|tcx|gpx)(\.gz)?$/i;
const ZIP_RE = /\.zip$/i;

const isJunk = (name: string): boolean =>
  name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\._/.test(name);

const baseName = (name: string): string => name.split('/').pop() ?? name;

/** Apply a Strava CSV row (name + type) to a decoded activity. */
function applyCsv(activity: DecodedActivity, row: StravaCsvActivity | undefined): DecodedActivity {
  if (!row) return activity;
  const next = { ...activity };
  if (row.name) next.name = row.name;
  if (row.type) next.sport = stravaTypeToSport(row.type);
  return next;
}

export async function walkActivityArchive(
  rootRef: string,
  host: ArchiveHost,
  onActivity: (activity: DecodedActivity) => void | Promise<void>,
  opts: {
    limits?: Partial<ImportLimits>;
    onProgress?: (p: WalkProgress) => void;
    onEntryError?: (err: unknown, entryName: string) => void;
    /**
     * The import's decompression budget, when the caller reads more from the
     * same archive afterwards (a "Trail + photos" zip's photos, #587) and
     * both must count against one total.
     */
    budget?: ByteBudget;
  } = {},
): Promise<WalkResult> {
  const limits: ImportLimits = { ...DEFAULT_IMPORT_LIMITS, ...opts.limits };
  const budget = opts.budget ?? new ByteBudget(limits.maxTotalBytes);
  const progress: WalkProgress = { processed: 0, discovered: 0 };
  const result: WalkResult = { failed: 0, limitReached: false };
  let seen = 0;

  const fail = (err: unknown, name: string) => {
    if (err instanceof ImportLimitError && budget.exhausted) result.limitReached = true;
    result.failed += 1;
    opts.onEntryError?.(err, name);
  };

  const readEntry = async (ref: string, entry: ZipEntry, max: number): Promise<Uint8Array> => {
    if (entry.uncompressedSize > max) {
      throw new ImportLimitError(`${entry.name} is larger than the per-file limit`);
    }
    const out = boundedCollector(max, budget);
    const open: SourceOpener = (fn) => host.open(ref, fn);
    await pumpZipEntry(open, entry, out.push, () => host.yieldToUi());
    return out.result();
  };

  const walk = async (ref: string, depth: number, csv: Map<string, StravaCsvActivity>) => {
    const entries = host.open(ref, (src) => listZipEntries(src)).filter((e) => !isJunk(e.name));

    // Strava's activities.csv names every activity; read it before the files.
    const csvEntry = entries.find((e) => baseName(e.name).toLowerCase() === 'activities.csv');
    if (csvEntry) {
      try {
        const rows = parseStravaActivitiesCsv(
          strFromU8(await readEntry(ref, csvEntry, limits.maxEntryBytes)),
        );
        csv = new Map([...csv, ...rows]);
      } catch {
        // Names are a nicety — the activities still import without them.
      }
    }

    const candidates = entries.filter((e) => ACTIVITY_RE.test(e.name) || ZIP_RE.test(e.name));
    progress.discovered += candidates.filter((e) => ACTIVITY_RE.test(e.name)).length;
    opts.onProgress?.({ ...progress });

    for (const entry of candidates) {
      if (result.limitReached) return;
      if (++seen > limits.maxEntries) {
        result.limitReached = true;
        return;
      }
      await host.yieldToUi();

      if (ZIP_RE.test(entry.name)) {
        if (depth + 1 > limits.maxDepth) {
          fail(new ImportLimitError(`${entry.name}: archives nested too deep`), entry.name);
          continue;
        }
        let spill: ArchiveSpill | undefined;
        try {
          if (entry.uncompressedSize > limits.maxNestedArchiveBytes) {
            throw new ImportLimitError(`${entry.name} is larger than the nested-archive limit`);
          }
          const s = host.createSpill();
          spill = s;
          let written = 0;
          try {
            await pumpZipEntry(
              (fn) => host.open(ref, fn),
              entry,
              (chunk) => {
                written += chunk.length;
                if (written > limits.maxNestedArchiveBytes) {
                  throw new ImportLimitError(`${entry.name} exceeds the nested-archive limit`);
                }
                budget.take(chunk.length);
                s.write(chunk);
              },
              () => host.yieldToUi(),
            );
          } finally {
            s.close();
          }
          await walk(s.ref, depth + 1, csv);
        } catch (err) {
          fail(err, entry.name);
        } finally {
          if (spill) host.discardSpill(spill.ref);
        }
        continue;
      }

      try {
        const bytes = await readEntry(ref, entry, limits.maxEntryBytes);
        const activities = decodeActivityFile(bytes, entry.name, {
          maxBytes: limits.maxEntryBytes,
          budget,
        });
        const row = csv.get(csvFileKey(entry.name));
        for (const activity of activities) await onActivity(applyCsv(activity, row));
      } catch (err) {
        fail(err, entry.name);
      }
      progress.processed += 1;
      opts.onProgress?.({ ...progress });
    }
  };

  await walk(rootRef, 0, new Map());
  return result;
}

/**
 * An {@link ArchiveHost} over in-memory buffers — for tests, and for small
 * archives that already sit in memory.
 */
export function memoryArchiveHost(files: Map<string, Uint8Array>): ArchiveHost & {
  spills: Map<string, Uint8Array>;
} {
  const spills = new Map<string, Uint8Array>();
  let next = 0;
  const lookup = (ref: string): Uint8Array => {
    const bytes = files.get(ref) ?? spills.get(ref);
    if (!bytes) throw new Error(`no such archive: ${ref}`);
    return bytes;
  };
  return {
    spills,
    open(ref, fn) {
      const bytes = lookup(ref);
      return fn({ size: bytes.length, read: (o, l) => bytes.subarray(o, o + l) });
    },
    createSpill() {
      const ref = `spill-${next++}`;
      const out = boundedCollector(Number.MAX_SAFE_INTEGER);
      return {
        ref,
        write: out.push,
        close: () => spills.set(ref, out.result()),
      };
    },
    discardSpill(ref) {
      spills.delete(ref);
    },
    yieldToUi: () => Promise.resolve(),
  };
}
