/**
 * The device's own copy of CHS tide-station data (owner decision 2026-10-05:
 * Canadian stations are fetched LIVE by the phone from CHS IWLS, never via
 * our tiles or Worker). Files under `Paths.document/chs/`:
 *
 * - `stations.json` — the IWLS /stations answer parsed to map features, with
 *   its fetch time; refreshed when older than a week (and online);
 * - `height-types.json` — the level-code table;
 * - `meta-{iwlsId}.json` — one station's metadata, written when its card
 *   opened, so the card works offline afterwards.
 *
 * Every CHS request goes through one limiter: 30 requests/min and 3/s, the
 * IWLS cap. A card open costs 1–2 metadata calls (+ the height types once)
 * and the live line 2 series calls.
 */
import {
  CHS_LIST_MAX_AGE_MS,
  chsHeightTypesUrl,
  chsMetadataUrl,
  chsStationsUrl,
  createRateLimiter,
  parseChsHeightTypes,
  parseChsStationList,
  type ChsFeatureCollection,
} from '@core/tides/chs';
import { Directory, File, Paths } from 'expo-file-system';

const DIR = 'chs';
const TIMEOUT_MS = 20_000;
const limiter = createRateLimiter(30, 3);

function dir(): Directory {
  const d = new Directory(Paths.document, DIR);
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

function readJson(name: string): unknown {
  try {
    const f = new File(dir(), name);
    return f.exists ? (JSON.parse(f.textSync()) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(name: string, value: unknown): void {
  try {
    const f = new File(dir(), name);
    if (f.exists) f.delete();
    f.create();
    f.write(JSON.stringify(value));
  } catch {
    // A full disk must never break the map: the data stays in memory this session.
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One CHS request, after the limiter allows it; aborts on `signal` or timeout. */
export async function chsGet(url: string, signal?: AbortSignal): Promise<unknown> {
  for (;;) {
    if (signal?.aborted) throw new Error('cancelled');
    const wait = limiter.waitMs(Date.now());
    if (wait <= 0 && limiter.take(Date.now())) break;
    await sleep(Math.max(wait, 50));
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`CHS ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

interface CachedList {
  fetchedAt: number;
  data: ChsFeatureCollection;
}

/** The cached station list (any age), or null. */
export function cachedChsStations(): CachedList | null {
  const raw = readJson('stations.json') as Partial<CachedList> | null;
  if (!raw || typeof raw.fetchedAt !== 'number' || raw.data?.type !== 'FeatureCollection')
    return null;
  return raw as CachedList;
}

export function chsListIsStale(c: CachedList | null, now = Date.now()): boolean {
  return c === null || now - c.fetchedAt > CHS_LIST_MAX_AGE_MS;
}

/** Fetch the list (one call), cache it, return it. Throws when offline. */
export async function refreshChsStations(signal?: AbortSignal): Promise<CachedList> {
  const data = parseChsStationList(await chsGet(chsStationsUrl(), signal));
  if (data.features.length === 0) throw new Error('empty CHS station list');
  const out = { fetchedAt: Date.now(), data };
  writeJson('stations.json', out);
  return out;
}

let heightTypes: Map<string, string> | null = null;

export async function chsHeightTypes(signal?: AbortSignal): Promise<Map<string, string>> {
  if (heightTypes && heightTypes.size > 0) return heightTypes;
  const cached = parseChsHeightTypes(readJson('height-types.json'));
  if (cached.size > 0) {
    heightTypes = cached;
    return cached;
  }
  const json = await chsGet(chsHeightTypesUrl(), signal);
  const parsed = parseChsHeightTypes(json);
  if (parsed.size > 0) {
    writeJson('height-types.json', json);
    heightTypes = parsed;
  }
  return parsed;
}

/** One station's metadata: live when possible (and cached), else the device copy. */
export async function chsMetadata(
  iwlsId: string,
  signal?: AbortSignal,
): Promise<{ json: unknown; fromCache: boolean } | null> {
  const name = `meta-${iwlsId.replace(/[^a-zA-Z0-9]/g, '')}.json`;
  try {
    const json = await chsGet(chsMetadataUrl(iwlsId), signal);
    writeJson(name, json);
    return { json, fromCache: false };
  } catch {
    const json = readJson(name);
    return json === null ? null : { json, fromCache: true };
  }
}
