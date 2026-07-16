/**
 * Pure disk-budget preflight for large writes — chiefly the offline region
 * download, which can run to hundreds of MB. Lives in `src/core` (no
 * react-native / expo imports) so it can be unit-tested in isolation; the
 * platform free-space read lives in `src/data/diskSpace`.
 *
 * The dev's device routinely runs near-full, so a download that would exhaust
 * the disk must be caught *before* it starts (block), and one that would eat
 * into the last of the free space should warn but still be allowed.
 */

/** proceed silently · warn-but-allow (tight) · block (won't fit safely). */
export type DiskVerdict = 'proceed' | 'warn' | 'block';

export interface DiskAssessment {
  verdict: DiskVerdict;
  /** A user-facing sentence for `warn`/`block`; `null` for `proceed`. */
  message: string | null;
  freeBytes: number;
  estimatedBytes: number;
  /** `estimatedBytes + safetyMarginBytes` — the free space we'd like to see. */
  requiredBytes: number;
}

export interface DiskBudgetOptions {
  /**
   * Bytes to keep free *after* the download as headroom, so the OS and app
   * don't wedge on a full disk. A download that fits but would dip below this
   * reserve is a `warn`, not a hard `block`.
   */
  safetyMarginBytes?: number;
}

/** Default reserve kept free beyond a download (200 MB). */
export const DEFAULT_SAFETY_MARGIN_BYTES = 200 * 1024 * 1024;

/** Bytes → a rough human size (callers add the "~"). "180 MB", "1.2 GB". */
export function formatByteSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  const KB = 1024;
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${Math.round(n / MB)} MB`;
  if (n >= KB) return `${Math.round(n / KB)} KB`;
  return `${Math.round(n)} B`;
}

/**
 * Decide whether a write of `estimatedBytes` is safe given `freeBytes` of free
 * disk, keeping a `safetyMarginBytes` reserve free afterwards.
 *
 * - `estimatedBytes <= 0` (unknown / nothing to write) → always `proceed`; we
 *   never block on an estimate we don't have.
 * - `freeBytes < estimatedBytes` → `block`: it cannot fit at all.
 * - `freeBytes < estimatedBytes + safetyMargin` → `warn`: it fits but would
 *   consume nearly all the remaining space.
 * - otherwise → `proceed`.
 */
export function assessDiskBudget(
  freeBytes: number,
  estimatedBytes: number,
  options: DiskBudgetOptions = {},
): DiskAssessment {
  const safetyMarginBytes = Math.max(0, options.safetyMarginBytes ?? DEFAULT_SAFETY_MARGIN_BYTES);
  const free = Number.isFinite(freeBytes) && freeBytes > 0 ? freeBytes : 0;
  const estimated = Number.isFinite(estimatedBytes) && estimatedBytes > 0 ? estimatedBytes : 0;
  const requiredBytes = estimated + safetyMarginBytes;

  // No meaningful estimate — don't stand in the way of a download we can't size.
  if (estimated === 0) {
    return { verdict: 'proceed', message: null, freeBytes: free, estimatedBytes: 0, requiredBytes };
  }

  if (free < estimated) {
    return {
      verdict: 'block',
      message: `This download needs ~${formatByteSize(estimated)} but only ${formatByteSize(
        free,
      )} is free. Free up space and try again.`,
      freeBytes: free,
      estimatedBytes: estimated,
      requiredBytes,
    };
  }

  if (free < requiredBytes) {
    return {
      verdict: 'warn',
      message: `This download (~${formatByteSize(
        estimated,
      )}) will use nearly all your free space (${formatByteSize(free)} left).`,
      freeBytes: free,
      estimatedBytes: estimated,
      requiredBytes,
    };
  }

  return {
    verdict: 'proceed',
    message: null,
    freeBytes: free,
    estimatedBytes: estimated,
    requiredBytes,
  };
}

/**
 * Whether a caught error / native message reads as an out-of-space write
 * failure (ENOSPC, SQLite full, the various OEM phrasings), so a generic
 * "download failed" can name the real cause instead. Pure string matching —
 * platform code passes the message in.
 */
export function isOutOfSpaceMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('enospc') ||
    m.includes('no space left') ||
    m.includes('not enough space') ||
    m.includes('disk full') ||
    m.includes('storage full') ||
    m.includes('out of space') ||
    m.includes('sqlite_full') ||
    m.includes('database or disk is full')
  );
}
