import { Gunzip } from 'fflate';

/**
 * Zip-bomb and memory guards for activity-file imports. Declared sizes in a
 * ZIP/GZIP header can lie, so every limit is enforced on the bytes actually
 * produced while decompressing, not on the headers.
 *
 * Chosen numbers (see `DEFAULT_IMPORT_LIMITS`):
 * - **200 MB per activity file** (after decompression). Real FIT files are
 *   0.1–5 MB, a 24 h ultra ~20 MB; a GPX/TCX of a multi-day hike tens of MB.
 *   Anything bigger is skipped (counted as failed), never decoded in memory.
 * - **2 GB per nested archive** spilled to disk (Garmin's
 *   `UploadedFiles_*.zip` parts run a few hundred MB).
 * - **4 GB decompressed in total** per import — a 10-year Garmin export is
 *   ~1–2 GB of FIT, and nested parts are counted twice (spill + entries).
 * - **Depth 3** of zips inside zips (Garmin needs 2).
 * - **50 000 candidate entries** per import.
 */
export interface ImportLimits {
  maxEntryBytes: number;
  maxNestedArchiveBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
  maxEntries: number;
}

const MB = 1024 * 1024;

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxEntryBytes: 200 * MB,
  maxNestedArchiveBytes: 2048 * MB,
  maxTotalBytes: 4096 * MB,
  maxDepth: 3,
  maxEntries: 50_000,
};

export class ImportLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportLimitError';
  }
}

/** Running total of decompressed bytes for one import. */
export class ByteBudget {
  used = 0;
  constructor(readonly max: number) {}
  take(n: number): void {
    this.used += n;
    if (this.used > this.max) {
      throw new ImportLimitError(`import exceeds ${Math.round(this.max / MB)} MB decompressed`);
    }
  }
  get exhausted(): boolean {
    return this.used > this.max;
  }
}

/**
 * A sink that concatenates chunks, throwing {@link ImportLimitError} past
 * `max` bytes (and charging `budget`, when given).
 */
export function boundedCollector(
  max: number,
  budget?: ByteBudget,
): { push: (chunk: Uint8Array) => void; result: () => Uint8Array } {
  const chunks: Uint8Array[] = [];
  let size = 0;
  return {
    push(chunk) {
      size += chunk.length;
      if (size > max) {
        throw new ImportLimitError(`file exceeds ${Math.round(max / MB)} MB decompressed`);
      }
      budget?.take(chunk.length);
      chunks.push(chunk);
    },
    result() {
      if (chunks.length === 1 && chunks[0]) return chunks[0];
      const out = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    },
  };
}

/** Does `bytes` start with the gzip magic (1F 8B)? */
export function looksLikeGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Gunzip (single or multi-member) with an output cap. */
export function gunzipBounded(bytes: Uint8Array, max: number, budget?: ByteBudget): Uint8Array {
  const out = boundedCollector(max, budget);
  const gz = new Gunzip((chunk) => out.push(chunk));
  gz.push(bytes, true);
  return out.result();
}
