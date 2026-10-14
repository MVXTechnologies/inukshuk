import { creditLine, type CreditLanguage } from '@core/catalog/credit';
import { uniquePath } from '@core/export/zipPaths';
import { formatBytes } from '@core/format';
import type { Area, MapDocument, TrackSummary, Waypoint } from '@core/models';

import { itemCount } from './selection';
import { waypointsGpx } from './shareGpx';
import { shareFileName } from './shareName';

/**
 * What "Send a copy" sends (#711), decided before anything is built so the
 * Share sheet can say exactly what will go: the file name, what is inside and
 * the size.
 *
 * - One trail: its `.gpx`.
 * - One personal map: its PDF (georeferencing preserved).
 * - Only waypoints and/or areas: one `.gpx` (areas in an extension, see
 *   `shareGpx`).
 * - A selection or a folder: a `.zip` named after the folder, or
 *   "Inukshuk · N items": one GPX per trail, one `Waypoints.gpx`, and the
 *   personal PDFs.
 * - Catalog maps (Cartes Plein-air etc.), alone or in a set: a LINK with the
 *   author credit, never the file. This is a licence term (link only, credit
 *   the author: the publisher's written permission of 2026-10-13). Alone,
 *   they go as text; in a zip, as `Catalog maps.txt`.
 *
 * Pure.
 */

/** A catalog map as it is shared: its name, the author credit and its page. */
export interface CatalogLink {
  name: string;
  credit: string | null;
  url: string | null;
}

export interface ShareFileEntry {
  /** Path inside the zip. */
  path: string;
  /** The stored file. */
  sourceUri: string;
  kind: 'gpx' | 'pdf';
}

export interface ShareTextEntry {
  path: string;
  text: string;
  kind: 'waypoints' | 'links';
}

export type SharePlan =
  | { kind: 'gpx'; fileName: string; sourceUri: string }
  | { kind: 'pdf'; fileName: string; sourceUri: string }
  | { kind: 'waypoints'; fileName: string; text: string; waypoints: number; areas: number }
  | { kind: 'link'; message: string; links: CatalogLink[] }
  | {
      kind: 'zip';
      fileName: string;
      files: ShareFileEntry[];
      texts: ShareTextEntry[];
      links: CatalogLink[];
      /** For the contents line and the file list. */
      trails: number;
      pdfs: number;
      waypoints: number;
      areas: number;
    };

export interface ShareInput {
  maps: readonly MapDocument[];
  tracks: readonly TrackSummary[];
  waypoints: readonly Waypoint[];
  areas: readonly Area[];
  /** Sharing a folder: the zip is named after it. */
  folderName?: string | null;
  /** The credit line's language (the device's). */
  lang: CreditLanguage;
}

/** A map from the catalog: shared only as a link. */
export function isCatalogMap(map: Pick<MapDocument, 'sourceItemId'>): boolean {
  return map.sourceItemId !== undefined;
}

export function catalogLink(map: MapDocument, lang: CreditLanguage): CatalogLink {
  return {
    name: map.name,
    credit: creditLine(map.sourceCredit, map.sourceFreeAt, lang) ?? null,
    url:
      map.sourcePageUrl ?? (map.sourceFreeAt !== undefined ? `https://${map.sourceFreeAt}` : null),
  };
}

/** The text the links go as: per map, its name, credit and page, a blank line between. */
export function linksText(links: readonly CatalogLink[]): string {
  return links
    .map((l) => [l.name, l.credit, l.url].filter((s): s is string => s !== null).join('\n'))
    .join('\n\n');
}

export const WAYPOINTS_FILE = 'Waypoints.gpx';
export const LINKS_FILE = 'Catalog maps.txt';

export function sharePlan(input: ShareInput): SharePlan | null {
  const catalog = input.maps.filter(isCatalogMap);
  const personal = input.maps.filter((m) => !isCatalogMap(m));
  const { tracks, waypoints, areas } = input;
  const links = catalog.map((m) => catalogLink(m, input.lang));
  const files = personal.length + tracks.length + waypoints.length + areas.length;
  const total = files + catalog.length;
  if (total === 0) return null;
  // Nothing but catalog maps: the links themselves, as text.
  if (files === 0) return { kind: 'link', message: linksText(links), links };

  if (input.folderName == null && catalog.length === 0) {
    const [onlyTrack] = tracks;
    if (files === 1 && onlyTrack) {
      return {
        kind: 'gpx',
        fileName: shareFileName(onlyTrack.name, 'gpx', 'Trail'),
        sourceUri: onlyTrack.fileUri,
      };
    }
    const [onlyMap] = personal;
    if (files === 1 && onlyMap) {
      return {
        kind: 'pdf',
        fileName: shareFileName(onlyMap.name, 'pdf', 'Map'),
        sourceUri: onlyMap.fileUri,
      };
    }
    if (personal.length === 0 && tracks.length === 0) {
      const [w] = waypoints;
      const [a] = areas;
      const single = files === 1 ? (w?.label ?? a?.name) : undefined;
      return {
        kind: 'waypoints',
        fileName: single !== undefined ? shareFileName(single, 'gpx', 'Waypoint') : WAYPOINTS_FILE,
        text: waypointsGpx(waypoints, areas, single ?? 'Waypoints'),
        waypoints: waypoints.length,
        areas: areas.length,
      };
    }
  }

  const taken = new Set<string>();
  const entries: ShareFileEntry[] = [
    ...personal.map((m) => ({
      path: uniquePath(taken, shareFileName(m.name, 'pdf', 'Map')),
      sourceUri: m.fileUri,
      kind: 'pdf' as const,
    })),
    ...tracks.map((t) => ({
      path: uniquePath(taken, shareFileName(t.name, 'gpx', 'Trail')),
      sourceUri: t.fileUri,
      kind: 'gpx' as const,
    })),
  ];
  const texts: ShareTextEntry[] = [];
  if (waypoints.length + areas.length > 0) {
    texts.push({
      path: uniquePath(taken, WAYPOINTS_FILE),
      text: waypointsGpx(waypoints, areas),
      kind: 'waypoints',
    });
  }
  if (links.length > 0) {
    texts.push({ path: uniquePath(taken, LINKS_FILE), text: linksText(links), kind: 'links' });
  }
  const name = input.folderName ?? `Inukshuk · ${itemCount(total)}`;
  return {
    kind: 'zip',
    fileName: shareFileName(name, 'zip', 'Inukshuk'),
    files: entries,
    texts,
    links,
    trails: tracks.length,
    pdfs: personal.length,
    waypoints: waypoints.length,
    areas: areas.length,
  };
}

/** "3 GPX + 1 PDF": what a zip holds (the Waypoints file counts as a GPX). */
export function zipContentsLine(plan: Extract<SharePlan, { kind: 'zip' }>): string {
  const gpx = plan.trails + (plan.waypoints + plan.areas > 0 ? 1 : 0);
  return [gpx > 0 ? `${gpx} GPX` : null, plan.pdfs > 0 ? `${plan.pdfs} PDF` : null]
    .filter((s): s is string => s !== null)
    .join(' + ');
}

/** "2 waypoints", "1 waypoint · 1 area": what a Waypoints file holds. */
export function waypointsContents(waypoints: number, areas: number): string {
  const parts: string[] = [];
  if (waypoints > 0) parts.push(`${waypoints} ${waypoints === 1 ? 'waypoint' : 'waypoints'}`);
  if (areas > 0) parts.push(`${areas} ${areas === 1 ? 'area' : 'areas'}`);
  return parts.join(' · ');
}

/** One line of the Share sheet's file list. */
export interface ShareListLine {
  icon: 'pdf' | 'gpx' | 'waypoints' | 'links';
  label: string;
}

/** Beyond this many files of a kind, the list says "5 trails as .gpx" instead. */
const LIST_EACH_UP_TO = 3;

/** The zip's contents, as the Share sheet lists them under "Send a copy". */
export function zipFileList(plan: Extract<SharePlan, { kind: 'zip' }>): ShareListLine[] {
  const lines: ShareListLine[] = [];
  const pdfs = plan.files.filter((f) => f.kind === 'pdf');
  const gpxs = plan.files.filter((f) => f.kind === 'gpx');
  if (pdfs.length > LIST_EACH_UP_TO) {
    lines.push({ icon: 'pdf', label: `${pdfs.length} maps as .pdf` });
  } else lines.push(...pdfs.map((f) => ({ icon: 'pdf' as const, label: f.path })));
  if (gpxs.length > LIST_EACH_UP_TO) {
    lines.push({ icon: 'gpx', label: `${gpxs.length} trails as .gpx` });
  } else lines.push(...gpxs.map((f) => ({ icon: 'gpx' as const, label: f.path })));
  for (const t of plan.texts) {
    lines.push(
      t.kind === 'waypoints'
        ? {
            icon: 'waypoints',
            label: `${t.path} (${waypointsContents(plan.waypoints, plan.areas)})`,
          }
        : {
            icon: 'links',
            label: `${t.path} (${plan.links.length} ${plan.links.length === 1 ? 'link' : 'links'})`,
          },
    );
  }
  return lines;
}

/** The host a set of links points at ("cartespleinair.org"), when they share one. */
export function linkHost(links: readonly CatalogLink[]): string | null {
  const hostOf = (url: string | null) =>
    url === null ? null : (/^https?:\/\/([^/?#]+)/i.exec(url)?.[1] ?? null);
  const [first] = links;
  const host = first ? hostOf(first.url) : null;
  return host !== null && links.every((l) => hostOf(l.url) === host) ? host : null;
}

/** The two lines under "Send a copy": what goes, then its contents and size. */
export function sendCopyLines(plan: SharePlan, bytes: number): [string, string | null] {
  const size = bytes > 0 ? formatBytes(bytes) : null;
  const join = (...parts: (string | null)[]) =>
    parts.filter((p): p is string => p !== null && p !== '').join(' · ') || null;
  switch (plan.kind) {
    case 'gpx':
    case 'pdf':
      return [plan.fileName, size];
    case 'waypoints':
      return [plan.fileName, join(waypointsContents(plan.waypoints, plan.areas), size)];
    case 'zip':
      return [plan.fileName, join(zipContentsLine(plan), size)];
    case 'link': {
      const host = linkHost(plan.links);
      const n = plan.links.length;
      const what =
        n === 1
          ? host !== null
            ? `The ${host} link`
            : 'The link'
          : host !== null
            ? `${n} ${host} links`
            : `${n} links`;
      return [what, n === 1 ? 'with the author credit' : 'with the author credits'];
    }
  }
}

/** The note under a zip that leaves catalog maps out (they go as links), or null. */
export function linksNote(links: readonly CatalogLink[]): string | null {
  const [first] = links;
  if (first === undefined) return null;
  const host = linkHost(links);
  const where = host !== null ? ` on ${host}` : '';
  return links.length === 1
    ? `${first.name} goes as a link. Catalog maps are shared as their page${where}, with the author credit, never as the file.`
    : `${links.length} catalog maps go as links. They are shared as their page${where}, with the author credit, never as the file.`;
}
