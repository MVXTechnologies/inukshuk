import type { CatalogItem, CatalogSource } from '../schema';
import { cpaPageUrl, type CpaMap } from './listing';
import { isoRegion, type RiverLocation } from './location';

/**
 * Cartes Plein-air maps as catalog rows (#680).
 *
 * The publisher's written permission (2026-10-13; terms in
 * docs/CATALOG-SOURCES.md §1.6) binds every row:
 *
 * 1. **Link, never copy.** `url` is the publisher's own file on its asset
 *    host; the phone downloads it from there. Nothing is mirrored, cached or
 *    proxied by us.
 * 2. **Credit the author.** `author` and `year` are the publisher's own credit,
 *    verbatim, and `pageUrl` links the map's page. The source's attribution
 *    names the site, never an author.
 * 3. **Never paid.** The source carries `freeAt`, so every card and detail
 *    page says "Available free at cartespleinair.org".
 *
 * The PDFs are not georeferenced, so the rows are `format: 'pdf'`: the app
 * lists them "not placed yet" and opens them as documents.
 */

export const CPA_SOURCE_ID = 'cartes-plein-air';
export const CPA_HOST = 'cartespleinair.org';

export const CPA_SOURCE: CatalogSource = {
  id: CPA_SOURCE_ID,
  name: 'Cartes Plein-air',
  licence: '© each map’s author · linked with permission, never copied',
  attribution: 'Published on cartespleinair.org; each map is credited to its own author',
  homepage: 'https://cartespleinair.org/cartes',
  freeAt: CPA_HOST,
};

/** What the crawler learnt about a map's current file (one HEAD, never a download). */
export interface CpaAsset {
  /** The file the map's page redirects to, on the publisher's asset host. */
  url: string;
  /** ETag, else the content hash in the file name: changes whenever the file does. */
  version: string;
  sizeBytes?: number;
  /** ISO date of the file (Last-Modified). */
  updatedAt?: string;
}

/** Catalog id: the site's map id, so a renamed slug is still the same map. */
export function cpaItemId(mapId: string): string {
  return `cpa-${mapId.toLowerCase()}`;
}

/**
 * The file's version: its ETag (quotes and weak marker dropped), else the
 * content hash the site puts in the file name (`…-e06f583d13bd.pdf`), else the
 * URL itself, which changes when the file does.
 */
export function assetVersion(url: string, etag: string | null | undefined): string {
  const tag = etag
    ?.trim()
    .replace(/^W\//, '')
    .replace(/^"(.*)"$/, '$1');
  if (tag !== undefined && tag !== '') return tag;
  const hash = /-([0-9a-f]{8,64})\.pdf$/i.exec(url)?.[1];
  return hash ?? url;
}

/** One catalog row. */
export function cpaItem(map: CpaMap, asset: CpaAsset, location: RiverLocation | null): CatalogItem {
  const region = isoRegion(map.regions);
  return {
    id: cpaItemId(map.id),
    sourceId: CPA_SOURCE_ID,
    title: map.title,
    category: 'river',
    kind: 'river',
    activities: ['paddling'],
    format: 'pdf',
    packaging: 'none',
    url: asset.url,
    pageUrl: cpaPageUrl(map.slug),
    author: map.author,
    ...(map.year !== undefined ? { year: map.year } : {}),
    version: asset.version,
    ...(region !== undefined ? { region } : {}),
    ...(location !== null ? { bbox: location.bbox, bboxPrecision: location.precision } : {}),
    ...(asset.sizeBytes !== undefined ? { sizeBytes: asset.sizeBytes } : {}),
    ...(asset.updatedAt !== undefined ? { updatedAt: asset.updatedAt } : {}),
  };
}
