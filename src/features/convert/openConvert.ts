/**
 * The one way into Convert, shared by every entry point: the map-tap chip,
 * the geodetic card, the tide-station card, the map-actions sheet and deep
 * links. A card adds Convert with one line:
 *
 *   onConvert={() => openConvert(router, prefillFromTideStation(station))}
 *
 * (prefills: `@core/convert/prefill` — prefillFromMark, prefillFromTideStation,
 * prefillFromPoint; or no request at all for an empty Convert).
 */
import { toParams, type ConvertRequest } from '@core/convert/prefill';
import type { useRouter } from 'expo-router';

type Router = ReturnType<typeof useRouter>;

export function convertHref(req?: ConvertRequest): {
  pathname: '/convert';
  params: Record<string, string>;
} {
  return { pathname: '/convert', params: req ? toParams(req) : {} };
}

export function openConvert(router: Pick<Router, 'push'>, req?: ConvertRequest): void {
  router.push(convertHref(req));
}
