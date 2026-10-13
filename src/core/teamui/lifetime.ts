/**
 * Team lifetime (#589 UI, owner B6): temporary teams, 14 days by default,
 * extendable by an admin up to a year after the founding (`t.extend` only
 * ever raises the expiry, and revives an expired team). Pure.
 */
const DAY = 24 * 3600_000;

export const LIFETIME_PRESETS = [
  { id: '1d', label: 'Today', days: 1 },
  { id: '3d', label: '3 days', days: 3 },
  { id: '14d', label: '14 days', days: 14 },
  { id: '30d', label: '30 days', days: 30 },
] as const;
export type LifetimeId = (typeof LIFETIME_PRESETS)[number]['id'];
export const DEFAULT_LIFETIME: LifetimeId = '14d';

export function lifetimeMs(id: LifetimeId): number {
  return (LIFETIME_PRESETS.find((p) => p.id === id)?.days ?? 14) * DAY;
}

export const EXTEND_PRESETS = [
  { id: '3d', label: '+3 days', days: 3 },
  { id: '7d', label: '+7 days', days: 7 },
  { id: '14d', label: '+14 days', days: 14 },
] as const;

/**
 * The new expiry for "+N days": from the later of now and the current
 * expiry (so extending an expired team revives it for N days from now),
 * capped at the protocol's maximum. Null when it would not move.
 */
export function extendedExpiry(
  current: number,
  days: number,
  now: number,
  max: number,
): number | null {
  const next = Math.min(Math.max(current, now) + days * DAY, max);
  return next > current ? Math.floor(next) : null;
}

/** "Ends in 13 days", "Ends today at 18:00", "Ended 2 days ago". */
export function expiryLine(expiresAt: number, now: number, closed: boolean): string {
  if (closed) return 'Closed by an admin · read-only';
  const left = expiresAt - now;
  if (left <= 0) {
    const ago = Math.floor(-left / DAY);
    return ago < 1
      ? 'Ended today · read-only'
      : `Ended ${ago} day${ago === 1 ? '' : 's'} ago · read-only`;
  }
  if (left < DAY) {
    const d = new Date(expiresAt);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `Ends at ${hh}:${mm}`;
  }
  const days = Math.ceil(left / DAY);
  return `Ends in ${days} days`;
}
