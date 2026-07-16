import { Paths } from 'expo-file-system';

import {
  assessDiskBudget,
  type DiskAssessment,
  type DiskBudgetOptions,
} from '@core/storage/diskBudget';

/**
 * Platform free-disk reader (SDK 56 `File`/`Directory`/`Paths` API). The pure
 * budgeting logic lives in `@core/storage/diskBudget`; this module only bridges
 * the real device number into it.
 *
 * SDK 56 exposes `Paths.availableDiskSpace` (a synchronous getter, in bytes) —
 * the legacy `getFreeDiskStorageAsync()` now throws at runtime, so we must not
 * use it. Reading disk space can still throw on some OEMs; callers should treat
 * a `null` as "couldn't tell" and not block on it.
 */

/** Available bytes on internal storage, or `null` if it can't be read. */
export function readAvailableDiskSpace(): number | null {
  try {
    const free = Paths.availableDiskSpace;
    return typeof free === 'number' && Number.isFinite(free) && free >= 0 ? free : null;
  } catch {
    return null;
  }
}

/**
 * Assess a pending write of `estimatedBytes` against the live free-disk figure.
 * Returns `null` when free space can't be read at all — the caller should then
 * proceed rather than block on missing information.
 */
export function assessFreeSpaceForWrite(
  estimatedBytes: number,
  options?: DiskBudgetOptions,
): DiskAssessment | null {
  const free = readAvailableDiskSpace();
  if (free === null) return null;
  return assessDiskBudget(free, estimatedBytes, options);
}
