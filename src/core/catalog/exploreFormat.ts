import type { Units } from '@core/format';
import { formatDistanceAway } from './nearbySections';

/**
 * Small display helpers for the map explorer's cards and badges (#447). Pure.
 */

/** "12 km" — the carousel's distance badge (the row's "12 km away", minus "away"). */
export function formatDistanceShort(meters: number, units: Units): string {
  return formatDistanceAway(meters, units).replace(/ away$/, '');
}

/**
 * A publisher's badge initials: its leading acronym when it has one
 * ("NRCan CanTopo" → "NRCan", "USGS US Topo" → "USGS"), else the initials of
 * its capitalised words ("Geoscience Australia" → "GA"), at most 5 letters.
 */
export function sourceAbbreviation(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const lead = words[0] ?? '';
  const upper = lead.replace(/[^A-Z]/g, '').length;
  if (lead.length >= 2 && lead.length <= 6 && upper >= 2) return lead;
  const initials = words
    .filter((w) => /^[A-ZÀ-Ý]/.test(w))
    .map((w) => w[0])
    .join('');
  return (initials !== '' ? initials : lead.slice(0, 2).toUpperCase()).slice(0, 5);
}

/** A stable pick among `count` badge colours for a source id (string hash). */
export function badgeIndex(id: string, count: number): number {
  if (count <= 0) return 0;
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % count;
}
