import Constants from 'expo-constants';

import type { InternetDeps } from '@data/sync/groupHost';
import type { WebSocketFactory, WebSocketLike } from '@data/sync/roomClient';

/**
 * The relay that introduces team phones over the internet (2.7.0, #705):
 * the `inukshuk-rtc` Worker (`infra/rtc/`), in the company's Cloudflare
 * account. Phones sign this exact host into every room entry (`rdv.ts`), so
 * it must equal the Worker's hostname.
 *
 * Like {@link TILE_HOST} (`basemapTiles.ts`), moving the relay is THIS ONE
 * LINE (OTA-updatable). Nothing here is secret: the Worker holds the TURN
 * key, and a phone gets in only by proving it holds a group's room key.
 */
export const RTC_HOST = 'rtc.mvxtechnologies.com';

/**
 * The relay host this build uses: `RTC_RELAY_HOST` at build time (a
 * `wrangler dev` tunnel in development), `none` for a nearby-only build, or
 * {@link RTC_HOST}.
 */
export function rtcRelayHost(): string | null {
  const value: unknown = Constants.expoConfig?.extra?.rtcRelayHost;
  if (value === 'none') return null;
  return typeof value === 'string' && value !== '' ? value : RTC_HOST;
}

/** React Native's WebSocket, as the room client sees it. */
export const nativeWebSocket: WebSocketFactory = (url) =>
  new WebSocket(url) as unknown as WebSocketLike;

/**
 * The internet paths of the app's `GroupHost` (G6/G7): the relay host and
 * the platform WebSocket; `react-native-webrtc` is loaded lazily by the host
 * (absent: the phone stays nearby-only). `undefined` when this build has no
 * relay.
 */
export function appInternetDeps(ws: WebSocketFactory = nativeWebSocket): InternetDeps | undefined {
  const host = rtcRelayHost();
  return host === null ? undefined : { host, ws };
}
