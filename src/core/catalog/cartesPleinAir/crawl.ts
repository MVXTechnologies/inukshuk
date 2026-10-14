import type { CatalogBbox, CatalogItem } from '../schema';
import { diffCatalogItems, massRemovalGuard, type CatalogDiff } from './diff';
import { assetVersion, cpaItem, cpaItemId, type CpaAsset } from './items';
import { cpaPageUrl, parseListing, type CpaMap, type CpaRiver } from './listing';
import {
  geonamesQueryUrl,
  mapLocation,
  matchGeoname,
  parseGeonames,
  type RiverLocation,
} from './location';
import type { PoliteRequest, PoliteResult, Validators } from './politeClient';
import { validatorsOf } from './politeClient';

/**
 * One crawl of Cartes Plein-air (#680), platform-free: the HTTP client is
 * injected (`./politeClient` in production, a fake in tests), so what the
 * crawler asks for — and what it never asks for — is tested.
 *
 * Requests, in order:
 * 1. `GET /cartes`, the listing (conditional when a cached copy exists).
 * 2. Per map, `HEAD /cartes/<slug>` without following the redirect: the
 *    `Location` is the map's current PDF on the asset host.
 * 3. Per map whose PDF URL is new, `HEAD` that PDF for its size, date and
 *    ETag. A PDF is **never downloaded**: the files are immutable (their name
 *    carries a content hash), so a URL we already know needs no request.
 * 4. Per river not yet in the gazetteer, one CGNDB name lookup (`./location`).
 *
 * Nothing is written when the result looks like a broken page rather than
 * the publisher's catalog (see `massRemovalGuard`).
 */

export const LISTING_URL = 'https://cartespleinair.org/cartes';

/** A river's cached lookup. `match` is absent when no single official feature matched. */
export interface GazetteerEntry {
  name: string;
  regions: string[];
  match?: { bbox: CatalogBbox; evidence: string };
  /** ISO date of the lookup. */
  checkedAt: string;
}

/** By the site's river id. */
export type Gazetteer = Record<string, GazetteerEntry>;

export interface CrawlClient {
  request(url: string, request?: PoliteRequest): Promise<PoliteResult>;
}

export interface ListingCache {
  validators: Validators;
  body: string;
}

export interface CrawlInput {
  client: CrawlClient;
  /** The items the last crawl published (the fragment's items). */
  previous: readonly CatalogItem[];
  gazetteer: Gazetteer;
  /** ISO date stamped on new gazetteer entries. */
  today: string;
  /** The listing from the last run, for a conditional GET. */
  listingCache?: ListingCache;
  /** Crawl only the first N maps (manual test runs; never publishes). */
  limit?: number;
  log?: (message: string) => void;
}

export interface CrawlOutput {
  items: CatalogItem[];
  gazetteer: Gazetteer;
  diff: CatalogDiff;
  warnings: string[];
  /** Set when the result must not be published, with the reason. */
  refused: string | null;
  /** The listing to cache for next time (when it carried validators). */
  listingCache?: ListingCache;
}

function sameRegions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((r, i) => r === b[i]);
}

/** On the publisher's own domain (the site or its asset host)? */
function isPublisherUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === 'https:' &&
      (hostname === 'cartespleinair.org' || hostname.endsWith('.cartespleinair.org'))
    );
  } catch {
    return false;
  }
}

function isoDate(header: string | null): string | undefined {
  if (header === null) return undefined;
  const ms = Date.parse(header);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
}

type Step<T> = { ok: true; value: T } | { ok: false; transient: boolean; reason: string };

export async function crawlCartesPleinAir(input: CrawlInput): Promise<CrawlOutput> {
  const { client } = input;
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    input.log?.(message);
  };
  const previousById = new Map(input.previous.map((i) => [i.id, i]));
  const empty = (refused: string): CrawlOutput => ({
    items: [...input.previous],
    gazetteer: input.gazetteer,
    diff: diffCatalogItems(input.previous, input.previous),
    warnings,
    refused,
  });

  // 1. The listing.
  const listing = await client.request(LISTING_URL, {
    method: 'GET',
    stayOn: isPublisherUrl,
    ...(input.listingCache !== undefined ? { validators: input.listingCache.validators } : {}),
  });
  if (listing.kind !== 'response') {
    return empty(
      listing.kind === 'disallowed'
        ? 'robots.txt disallows the listing page'
        : `listing unavailable (${listing.reason})`,
    );
  }
  let html: string;
  let listingCache: ListingCache | undefined;
  if (listing.response.status === 304 && input.listingCache !== undefined) {
    html = input.listingCache.body;
    listingCache = input.listingCache;
  } else if (listing.response.status === 200) {
    html = await listing.response.text();
    const validators = validatorsOf(listing.response);
    if (validators.etag !== undefined || validators.lastModified !== undefined) {
      listingCache = { validators, body: html };
    }
  } else {
    return empty(`listing answered HTTP ${listing.response.status}`);
  }

  const parsed = parseListing(html);
  for (const w of parsed.warnings) warn(`listing: ${w}`);
  const maps = input.limit !== undefined ? parsed.maps.slice(0, input.limit) : parsed.maps;

  // 2–3. Each map's current file.
  const resolveAsset = async (map: CpaMap): Promise<Step<CpaAsset>> => {
    const page = await client.request(cpaPageUrl(map.slug), { method: 'HEAD', redirect: 'manual' });
    if (page.kind === 'disallowed') return { ok: false, transient: false, reason: 'robots.txt' };
    if (page.kind === 'failed') return { ok: false, transient: true, reason: page.reason };
    const { status, headers } = page.response;
    let url: string;
    if (status >= 300 && status < 400) {
      const location = headers.get('location');
      if (location === null)
        return { ok: false, transient: false, reason: `${status} without Location` };
      url = new URL(location, cpaPageUrl(map.slug)).toString();
    } else if (status === 200 && /pdf/i.test(headers.get('content-type') ?? '')) {
      url = cpaPageUrl(map.slug);
    } else {
      return { ok: false, transient: false, reason: `map page answered HTTP ${status}` };
    }
    if (!isPublisherUrl(url)) {
      return { ok: false, transient: false, reason: `redirects off the publisher's site (${url})` };
    }

    const known = previousById.get(cpaItemId(map.id));
    if (known !== undefined && known.url === url && known.version !== undefined) {
      return {
        ok: true,
        value: {
          url,
          version: known.version,
          ...(known.sizeBytes !== undefined ? { sizeBytes: known.sizeBytes } : {}),
          ...(known.updatedAt !== undefined ? { updatedAt: known.updatedAt } : {}),
        },
      };
    }
    // `identity`: a HEAD that offers gzip may come back without Content-Length.
    const file = await client.request(url, {
      method: 'HEAD',
      headers: { 'Accept-Encoding': 'identity' },
      stayOn: isPublisherUrl,
    });
    if (file.kind === 'disallowed')
      return { ok: false, transient: false, reason: 'robots.txt (file)' };
    if (file.kind === 'failed') return { ok: false, transient: true, reason: file.reason };
    // The file host may redirect again (a CDN): never off the publisher's site
    // (`stayOn` stopped there and answered with the redirect itself).
    const onward = file.response.headers.get('location');
    if (file.response.status >= 300 && file.response.status < 400 && onward !== null) {
      return {
        ok: false,
        transient: false,
        reason: `file redirects off the publisher's site (${new URL(onward, file.url).toString()})`,
      };
    }
    const type = file.response.headers.get('content-type') ?? '';
    if (file.response.status !== 200 || !/pdf|octet-stream/i.test(type)) {
      return {
        ok: false,
        transient: false,
        reason: `file answered HTTP ${file.response.status} ${type}`.trim(),
      };
    }
    const length = Number(file.response.headers.get('content-length'));
    const updatedAt = isoDate(file.response.headers.get('last-modified'));
    return {
      ok: true,
      value: {
        url,
        version: assetVersion(url, file.response.headers.get('etag')),
        ...(Number.isFinite(length) && length > 0 ? { sizeBytes: length } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      },
    };
  };

  // 4. Each river's location, looked up once and cached.
  const gazetteer: Gazetteer = { ...input.gazetteer };
  const locateRiver = async (river: CpaRiver): Promise<RiverLocation | null> => {
    let entry = gazetteer[river.id];
    if (
      entry === undefined ||
      entry.name !== river.name ||
      !sameRegions(entry.regions, river.regions)
    ) {
      const url = geonamesQueryUrl(river);
      let match: RiverLocation | null = null;
      if (url !== null) {
        const answer = await client.request(url);
        if (answer.kind !== 'response' || answer.response.status !== 200) {
          // Not cached: a failed lookup is retried next week, not remembered as "no match".
          warn(`no name lookup for river "${river.name}"; located by region this time`);
          return null;
        }
        let body: unknown = null;
        try {
          body = JSON.parse(await answer.response.text());
        } catch {
          warn(`unreadable name lookup for river "${river.name}"`);
        }
        match = matchGeoname(river, parseGeonames(body));
      }
      entry = {
        name: river.name,
        regions: [...river.regions],
        ...(match !== null ? { match: { bbox: match.bbox, evidence: match.evidence } } : {}),
        checkedAt: input.today,
      };
      gazetteer[river.id] = entry;
    }
    return entry.match !== undefined
      ? { bbox: entry.match.bbox, precision: 'river', evidence: entry.match.evidence }
      : null;
  };

  const items: CatalogItem[] = [];
  for (const map of maps) {
    const asset = await resolveAsset(map);
    if (!asset.ok) {
      const known = previousById.get(cpaItemId(map.id));
      if (asset.transient && known !== undefined) {
        warn(`${map.slug}: ${asset.reason}; kept last week's row`);
        items.push(known);
      } else {
        warn(`${map.slug}: ${asset.reason}; left out`);
      }
      continue;
    }
    const rivers: (RiverLocation | null)[] = [];
    for (const river of map.rivers) rivers.push(await locateRiver(river));
    items.push(cpaItem(map, asset.value, mapLocation(rivers, map.regions)));
  }
  items.sort((a, b) => a.id.localeCompare(b.id));

  const diff = diffCatalogItems(input.previous, items);
  const refused =
    input.limit !== undefined
      ? `--limit ${input.limit}: a partial crawl is never published`
      : massRemovalGuard(input.previous.length, items.length, diff.removed.length);
  return {
    items,
    gazetteer,
    diff,
    warnings,
    refused,
    ...(listingCache !== undefined ? { listingCache } : {}),
  };
}
