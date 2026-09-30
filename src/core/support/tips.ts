/**
 * The tip jar (#476): five consumable in-app products, all of which unlock
 * nothing. They are donations of different sizes, and the copy says so; no
 * tier is described as paying for a feature.
 *
 * The store owns the price. What the app owns is the tier's name, its one-line
 * meaning, its icon and its order, joined here with whatever the store
 * returned. A tier the store did not return (not yet approved, removed, not
 * sold in this storefront) is simply not offered; nothing is ever shown with a
 * hard-coded price.
 *
 * {@link TIP_USD} is different: the USD *base* price of each product, used
 * only to add up the person's own giving for the donors list (a localized
 * price in another currency cannot be summed against a $100 threshold).
 *
 * Pure: no React Native / Expo imports.
 */

export type TipId = 'tip_small' | 'tip_medium' | 'tip_large' | 'tip_xlarge' | 'tip_patron';

export interface TipTier {
  id: TipId;
  name: string;
  what: string;
  /** Material Community Icons glyph. */
  icon: string;
}

/** Catalog order is display order: smallest first. */
export const TIP_TIERS: readonly TipTier[] = [
  {
    id: 'tip_small',
    name: 'Coffee at the trailhead',
    what: 'A small thank-you',
    icon: 'coffee-outline',
  },
  {
    id: 'tip_medium',
    name: 'Lunch at the lookout',
    what: 'A warm thank-you',
    icon: 'food-apple-outline',
  },
  {
    id: 'tip_large',
    name: 'A day on the trail',
    what: 'A generous thank-you',
    icon: 'hiking',
  },
  {
    id: 'tip_xlarge',
    name: 'A season of trails',
    what: 'For a season of good outings',
    icon: 'pine-tree',
  },
  {
    id: 'tip_patron',
    name: 'Patron of the trail',
    what: 'For those who can give more',
    icon: 'hand-heart-outline',
  },
];

/**
 * The USD base price of each product, as set in App Store Connect and Play
 * Console. Keep in step with the consoles; used only for the donors-list
 * threshold, never displayed.
 */
export const TIP_USD: Readonly<Record<TipId, number>> = {
  tip_small: 2.99,
  tip_medium: 6.99,
  tip_large: 14.99,
  tip_xlarge: 29.99,
  tip_patron: 99.99,
};

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
 * Which offer starts selected: the second tier when it is on sale (a modest
 * default, never the biggest), else the first. Null when nothing is on sale.
 */
export function defaultTipId(offers: readonly TipOffer[]): TipId | null {
  const preferred = offers.find((o) => o.id === 'tip_medium') ?? offers[0];
  return preferred?.id ?? null;
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
