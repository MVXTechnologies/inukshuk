import type { LegMode, LegResult } from '@core/draw/legs';
import { legResultFromResponse, routeRequestBody } from '@core/draw/routing';
import type { LngLat } from '@core/models';

import { TILE_HOST } from './basemapTiles';

/**
 * Route snapping over the network (#515): one leg of a drawn route, asked of
 * our Worker's `POST /route`, which forwards it to the routing engine (BRouter
 * for trails, Valhalla for roads — chosen and swappable on the Worker, so the
 * app never names a provider) and caches the answer.
 *
 * Never throws: every failure is a `failed` leg the editor draws straight.
 */

/** Our Worker's route endpoint (same host as the base map). */
export const ROUTE_URL = `${TILE_HOST}/route`;

/** A slow engine (a long mountain leg) gets this long before we give up. */
const TIMEOUT_MS = 20_000;
/** One quiet retry when the Worker says the engine is busy. */
const BUSY_RETRY_MS = 1_500;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function ask(mode: LegMode, from: LngLat, to: LngLat): Promise<LegResult> {
  const body = routeRequestBody(mode, from, to);
  if (body === null) return { status: 'failed', reason: 'error' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(ROUTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // No connection (or our timeout): the leg stays straight, retry later.
    return { status: 'failed', reason: 'offline' };
  } finally {
    clearTimeout(timer);
  }
  const json: unknown = await res.json().catch(() => null);
  return legResultFromResponse(res.status, json);
}

/** Route one leg; a busy answer is retried once after a short pause. */
export async function routeLeg(mode: LegMode, from: LngLat, to: LngLat): Promise<LegResult> {
  const first = await ask(mode, from, to);
  if (first.status === 'failed' && first.reason === 'busy') {
    await wait(BUSY_RETRY_MS);
    return ask(mode, from, to);
  }
  return first;
}
