import { hasContent, parseCostsDocument, type CostsDocument } from '@core/support/costs';

import * as storage from './storage';

/** Parse, keeping only a document that says something. */
function usable(raw: unknown): CostsDocument | null {
  const { doc } = parseCostsDocument(raw);
  return doc !== null && hasContent(doc) ? doc : null;
}

/**
 * Fetch + on-device cache for the public accounts (`docs/support/costs.json`,
 * #476) shown on the Support screen.
 *
 * The file changes once a month, so a copy younger than a day is served
 * without asking the network. Every failure — offline, "Locally downloaded
 * only" on, a timeout, a broken file — falls back to the last good copy, and
 * with no copy at all the loader returns null and the screen quietly leaves
 * the progress block out. Never throws.
 */

export const SUPPORT_COSTS_URL = 'https://inukshuk.mvxtechnologies.com/support/costs.json';
const CACHE_FILE = 'support-costs.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

interface CachedCosts {
  fetchedAt: number;
  raw: unknown;
}

export interface SupportCostsResult {
  doc: CostsDocument;
  fromCache: boolean;
}

function isCachedCosts(value: unknown): value is CachedCosts {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CachedCosts).fetchedAt === 'number' &&
    'raw' in value
  );
}

async function readCache(): Promise<CachedCosts | null> {
  try {
    const cached = await storage.readJson<unknown>(CACHE_FILE);
    return isCachedCosts(cached) ? cached : null;
  } catch {
    return null;
  }
}

async function fetchCosts(): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SUPPORT_COSTS_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`costs fetch failed: HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

export async function loadSupportCosts(options?: {
  force?: boolean;
}): Promise<SupportCostsResult | null> {
  const cached = await readCache();
  const cachedDoc = cached === null ? null : usable(cached.raw);
  const fresh = cached !== null && Date.now() - cached.fetchedAt < CACHE_TTL_MS;

  if (cachedDoc !== null && fresh && options?.force !== true) {
    return { doc: cachedDoc, fromCache: true };
  }
  // "Locally downloaded only" means no network at all, not even this.
  if (storage.isNetworkAllowed()) {
    try {
      const raw = await fetchCosts();
      const doc = usable(raw);
      if (doc !== null) {
        try {
          storage.writeJson(CACHE_FILE, { fetchedAt: Date.now(), raw } satisfies CachedCosts);
        } catch {
          // A failed cache write (disk full) must not hide fresh numbers.
        }
        return { doc, fromCache: false };
      }
    } catch {
      // Offline or unreachable: fall through to the cached copy.
    }
  }
  return cachedDoc === null ? null : { doc: cachedDoc, fromCache: true };
}
