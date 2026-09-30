import type { DonorSubmission } from '@core/support/donors';

import { TILE_HOST } from './basemapTiles';

/**
 * Sends an opt-in donor name to the tile Worker (`POST /donors`, #476). The
 * Worker only files it as *pending*: the owner checks the transaction ids
 * against the store reports and publishes the name in `costs.json` by hand.
 */

export const DONORS_URL = `${TILE_HOST}/donors`;
const TIMEOUT_MS = 15_000;

export type DonorSubmitResult = 'sent' | 'rate-limited' | 'rejected' | 'offline';

export async function submitDonorName(body: DonorSubmission): Promise<DonorSubmitResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(DONORS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.ok) return 'sent';
    if (res.status === 429) return 'rate-limited';
    if (res.status >= 400 && res.status < 500) return 'rejected';
    return 'offline';
  } catch {
    return 'offline';
  } finally {
    clearTimeout(timer);
  }
}
