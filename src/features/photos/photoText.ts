import { formatClockTime } from '@core/format';

/** "Sun 27 Sep 2026 · 10:32" in the device's locale (the viewer's when-line). */
export function formatPhotoWhen(epochMs: number): string {
  const date = new Date(epochMs).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return `${date} · ${formatClockTime(epochMs)}`;
}

/** A photo's short label: its caption, else its clock time, else "Photo N". */
export function photoLabel(photo: { caption?: string; takenAt?: number }, number: number): string {
  const caption = photo.caption?.trim();
  if (caption) return caption;
  if (photo.takenAt !== undefined) return formatClockTime(photo.takenAt);
  return `Photo ${number}`;
}
