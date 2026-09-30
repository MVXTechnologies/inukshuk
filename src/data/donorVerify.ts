import type { CheckResult } from '@core/support/verify';

import { TILE_HOST } from './basemapTiles';

/**
 * "I already donated" (#476): the two calls to the tile Worker. The Worker
 * emails a 6-digit code (`/start`) and says whether a code matches
 * (`/check`); it keeps only a salted hash for 15 minutes.
 */

export const VERIFY_START_URL = `${TILE_HOST}/donor-verify/start`;
export const VERIFY_CHECK_URL = `${TILE_HOST}/donor-verify/check`;
const TIMEOUT_MS = 15_000;

export type StartResult = 'sent' | 'rate-limited' | 'invalid' | 'offline';

async function post(url: string, body: unknown): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function startDonorVerify(email: string): Promise<StartResult> {
  const res = await post(VERIFY_START_URL, { email });
  if (res === null) return 'offline';
  if (res.ok) return 'sent';
  if (res.status === 429) return 'rate-limited';
  if (res.status === 400) return 'invalid';
  return 'offline';
}

export async function checkDonorVerify(email: string, code: string): Promise<CheckResult> {
  const res = await post(VERIFY_CHECK_URL, { email, code });
  if (res === null) return 'offline';
  if (res.ok) return 'ok';
  if (res.status === 429) return 'rate-limited';
  if (res.status === 400) return 'rejected';
  return 'offline';
}
