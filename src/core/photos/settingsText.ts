import { formatBytes } from '@core/format';

/**
 * Settings → Photos wording (#587), pure so the numbers are tested.
 */

export interface PhotoUsageCounts {
  photos: number;
  trails: number;
  bytes: number;
}

/** "33 photos on 2 trails · 19 MB", or a plain "none yet". */
export function describePhotoUsage(usage: PhotoUsageCounts | null): string {
  if (usage === null) return 'Counting…';
  if (usage.photos === 0) return 'No photo copies yet';
  const photos = usage.photos === 1 ? '1 photo' : `${usage.photos} photos`;
  const trails = usage.trails === 1 ? '1 trail' : `${usage.trails} trails`;
  return `${photos} on ${trails} · ${formatBytes(usage.bytes)}`;
}

/** The "Delete all photo copies" confirmation. */
export function deleteAllPhotosPrompt(usage: PhotoUsageCounts | null): string {
  const what =
    usage && usage.photos > 0
      ? `the ${usage.photos === 1 ? 'copy' : `${usage.photos} copies`} Inukshuk keeps`
      : 'every copy Inukshuk keeps';
  return `Delete ${what} for your trails? Your phone's photo library is not touched. This can't be undone.`;
}
