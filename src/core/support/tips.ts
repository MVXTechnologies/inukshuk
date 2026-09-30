/**
 * The tip jar (#476): three consumable in-app products that unlock nothing.
 *
 * The store owns the price. What the app owns is the tier's name, its one-line
 * meaning, its icon and its order — joined here with whatever the store
 * returned. A tier the store did not return (not yet approved, removed, not
 * sold in this storefront) is simply not offered; nothing is ever shown with a
 * hard-coded price.
 *
 * Pure: no React Native / Expo imports.
 */

export type TipId = 'tip_small' | 'tip_medium' | 'tip_large';

export interface TipTier {
  id: TipId;
  name: string;
  what: string;
  /** Material Community Icons glyph. */
  icon: string;
}

/** Catalog order is display order: smallest first, like the mockup. */
export const TIP_TIERS: readonly TipTier[] = [
  {
    id: 'tip_small',
    name: 'Coffee at the trailhead',
    what: 'Thanks for the app',
    icon: 'coffee-outline',
  },
  {
    id: 'tip_medium',
    name: 'A map sheet',
    what: 'Keeps a map region online for a month',
    icon: 'map-outline',
  },
  {
    id: 'tip_large',
    name: 'A month of servers',
    what: 'Tiles, trails, contours and the Strava link',
    icon: 'server',
  },
];

export const TIP_IDS: readonly TipId[] = TIP_TIERS.map((t) => t.id);

export function isTipId(value: unknown): value is TipId {
  return typeof value === 'string' && (TIP_IDS as readonly string[]).includes(value);
}

/** A product as the store adapter reports it: its id and localized price. */
export interface StoreProduct {
  id: string;
  /** Localized by the store, e.g. `$2.99`, `2,99 $`, `3,49 €`. */
  displayPrice: string;
}

export interface TipOffer extends TipTier {
  displayPrice: string;
}

/** The tiers the store can actually sell, in catalog order, with store prices. */
export function tipOffers(products: readonly StoreProduct[]): TipOffer[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  const offers: TipOffer[] = [];
  for (const tier of TIP_TIERS) {
    const product = byId.get(tier.id);
    if (product && product.displayPrice.trim() !== '') {
      offers.push({ ...tier, displayPrice: product.displayPrice.trim() });
    }
  }
  return offers;
}

/**
 * Which offer starts selected: the middle one when there are three (the
 * mockup's default), else the first. Null when nothing is on sale.
 */
export function defaultTipId(offers: readonly TipOffer[]): TipId | null {
  const middle = offers.length === 3 ? offers[1] : offers[0];
  return middle?.id ?? null;
}

/**
 * How a failed or interrupted purchase should read. The adapter hands over the
 * store's error code as a string (expo-iap's `ErrorCode` values).
 *
 * - `cancelled`: the person backed out — say nothing.
 * - `pending`: Ask to Buy / a slow payment method — the tip may still arrive.
 * - `unavailable`: billing is not usable on this device or account.
 * - `network`: try again later.
 * - `failed`: anything else.
 */
export type TipFailure = 'cancelled' | 'pending' | 'unavailable' | 'network' | 'failed';

const FAILURES: Readonly<Record<string, TipFailure>> = {
  'user-cancelled': 'cancelled',
  'deferred-payment': 'pending',
  pending: 'pending',
  'billing-unavailable': 'unavailable',
  'iap-not-available': 'unavailable',
  'feature-not-supported': 'unavailable',
  'item-unavailable': 'unavailable',
  'sku-not-found': 'unavailable',
  'init-connection': 'unavailable',
  'not-prepared': 'unavailable',
  'network-error': 'network',
  'service-disconnected': 'network',
  'service-timeout': 'network',
  'service-error': 'network',
  'remote-error': 'network',
  'connection-closed': 'network',
};

export function classifyTipFailure(code: string | null | undefined): TipFailure {
  if (typeof code !== 'string') return 'failed';
  return FAILURES[code] ?? 'failed';
}

/** What to tell the person after a purchase that did not complete (null = nothing). */
export function tipFailureMessage(failure: TipFailure): string | null {
  switch (failure) {
    case 'cancelled':
      return null;
    case 'pending':
      return 'Your tip is waiting for approval. It will go through on its own. Thank you!';
    case 'unavailable':
      return "Tips aren't available on this device right now.";
    case 'network':
      return "Couldn't reach the store. Check your connection and try again.";
    case 'failed':
      return 'The tip did not go through. Please try again later.';
  }
}
