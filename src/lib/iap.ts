import { isTipId, type StoreProduct } from '@core/support/tips';
import { requireOptionalNativeModule } from 'expo';

/**
 * The tip jar's only door to the App Store / Google Play (#476), over
 * `expo-iap` (OpenIAP: StoreKit 2 on iOS, Play Billing on Android).
 *
 * Thin on purpose: the screen and its tests talk to {@link TipStore}, never to
 * expo-iap, so the whole flow is testable with a fake store and the library
 * could be swapped without touching a screen.
 *
 * Three rules this file exists to keep:
 *
 * 1. **Never crash for want of a store.** A build without the native module
 *    (an older binary running this JS through an update, Expo Go), a
 *    simulator with no products, or a device with no billing account all end
 *    up as "tips aren't available here" — {@link getTipStore} returns null
 *    before expo-iap is even loaded, because expo-iap resolves its native
 *    module lazily and would throw at the first call.
 * 2. **Consume every tip.** Tips are consumables: each completed purchase is
 *    finished with `isConsumable: true` so the same tip can be given again
 *    (Android also refunds anything left unacknowledged for three days).
 *    Pending purchases are *not* finished — Play forbids consuming them; they
 *    come back through the listener once paid, or are swept up by
 *    {@link TipStore.sweepUnfinished} on a later visit.
 * 3. **Unlock nothing.** There is no entitlement to restore, so there is no
 *    restore button. The only thing kept is the running total of the
 *    person's own tips (`state/supportStore`), for the opt-in donors list.
 */

/** A purchase outcome, as the Support screen needs to hear it. */
export type TipEvent =
  | { kind: 'purchased'; productId: string; transactionId: string | null }
  | { kind: 'pending'; productId: string }
  | { kind: 'error'; code: string | null; message: string };

/** A tip the store confirmed and this device finished. */
export interface FinishedTip {
  productId: string;
  transactionId: string | null;
}

export interface TipStore {
  /** Open the billing connection; false when the store is unusable here. */
  connect(): Promise<boolean>;
  fetchTips(ids: readonly string[]): Promise<StoreProduct[]>;
  /** Start the store's purchase sheet; the outcome arrives through `subscribe`. */
  requestTip(id: string): Promise<void>;
  /** Listen for outcomes. Completed tips are consumed before `purchased` fires. */
  subscribe(listener: (event: TipEvent) => void): () => void;
  /** Consume tips left unfinished by an earlier session (app killed mid-purchase, Ask to Buy). */
  sweepUnfinished(): Promise<FinishedTip[]>;
  disconnect(): Promise<void>;
}

// --- The slice of expo-iap this adapter uses --------------------------------
// Declared locally so this file type-checks and tests run without the package
// (and without its native module). Field names follow expo-iap 5.x.

interface IapProduct {
  id: string;
  displayPrice: string;
}

interface IapPurchase {
  /** The store transaction id (iOS transaction id, Play order id). */
  id?: string | null;
  productId: string;
  purchaseState: 'pending' | 'purchased' | 'unknown';
}

interface IapError {
  code?: string | null;
  message?: string | null;
}

interface IapSubscription {
  remove(): void;
}

export interface ExpoIapSlice {
  initConnection(): Promise<boolean>;
  endConnection(): Promise<boolean>;
  fetchProducts(request: { skus: string[]; type: 'in-app' }): Promise<IapProduct[] | null>;
  requestPurchase(args: {
    request: { apple: { sku: string }; google: { skus: string[] } };
    type: 'in-app';
  }): Promise<unknown>;
  finishTransaction(args: { purchase: IapPurchase; isConsumable: boolean }): Promise<void>;
  getAvailablePurchases(): Promise<IapPurchase[]>;
  purchaseUpdatedListener(listener: (purchase: IapPurchase) => void): IapSubscription;
  purchaseErrorListener(listener: (error: IapError) => void): IapSubscription;
}

/** expo-iap's native module names: plain builds, and the Onside marketplace build. */
const NATIVE_MODULES = ['ExpoIap', 'ExpoIapOnside'];

function loadExpoIap(): ExpoIapSlice | null {
  try {
    const present = NATIVE_MODULES.some((name) => requireOptionalNativeModule(name) !== null);
    if (!present) return null;
    // A try/catch'd require is an optional dependency to Metro: a bundle built
    // before expo-iap is installed still resolves, and lands here as null.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-iap') as ExpoIapSlice;
  } catch {
    return null;
  }
}

function transactionIdOf(purchase: IapPurchase): string | null {
  return typeof purchase.id === 'string' && purchase.id !== '' ? purchase.id : null;
}

function errorEvent(error: unknown): TipEvent {
  const e = (typeof error === 'object' && error !== null ? error : {}) as IapError;
  return {
    kind: 'error',
    code: typeof e.code === 'string' ? e.code : null,
    message: typeof e.message === 'string' ? e.message : String(error),
  };
}

/**
 * One billing connection shared by every user of a module (the Support
 * screen, the launch sweep): opened by the first `connect`, closed by the
 * last `disconnect`, so one caller finishing never cuts the other off.
 */
interface SharedConnection {
  users: number;
  opening: Promise<boolean> | null;
}
const connections = new WeakMap<ExpoIapSlice, SharedConnection>();

function sharedConnection(iap: ExpoIapSlice): SharedConnection {
  let shared = connections.get(iap);
  if (shared === undefined) {
    shared = { users: 0, opening: null };
    connections.set(iap, shared);
  }
  return shared;
}

/** Wrap an expo-iap module (exported for tests, which pass a fake). */
export function createTipStore(iap: ExpoIapSlice): TipStore {
  const finish = (purchase: IapPurchase) => iap.finishTransaction({ purchase, isConsumable: true });
  const shared = sharedConnection(iap);
  let connected = false;

  return {
    async connect() {
      if (!connected) {
        connected = true;
        shared.users++;
      }
      shared.opening ??= iap.initConnection().catch(() => false);
      const ok = await shared.opening;
      // A failed open is retried by the next caller rather than cached.
      if (!ok) shared.opening = null;
      return ok;
    },

    async fetchTips(ids) {
      const products = await iap.fetchProducts({ skus: [...ids], type: 'in-app' });
      return (products ?? [])
        .filter((p) => typeof p.id === 'string' && typeof p.displayPrice === 'string')
        .map((p) => ({ id: p.id, displayPrice: p.displayPrice }));
    },

    async requestTip(id) {
      await iap.requestPurchase({
        request: { apple: { sku: id }, google: { skus: [id] } },
        type: 'in-app',
      });
    },

    subscribe(listener) {
      const updates = iap.purchaseUpdatedListener((purchase) => {
        // Only our own products: never finish something this screen did not sell.
        if (!isTipId(purchase.productId)) return;
        if (purchase.purchaseState === 'pending') {
          listener({ kind: 'pending', productId: purchase.productId });
          return;
        }
        if (purchase.purchaseState !== 'purchased') return;
        finish(purchase)
          .catch(() => {
            // The money moved; say thanks anyway. The next sweep retries the
            // consume, well within Play's three-day window.
          })
          .finally(() =>
            listener({
              kind: 'purchased',
              productId: purchase.productId,
              transactionId: transactionIdOf(purchase),
            }),
          );
      });
      const errors = iap.purchaseErrorListener((error) => listener(errorEvent(error)));
      return () => {
        updates.remove();
        errors.remove();
      };
    },

    async sweepUnfinished() {
      const purchases = await iap.getAvailablePurchases();
      const finished: FinishedTip[] = [];
      for (const purchase of purchases) {
        if (isTipId(purchase.productId) && purchase.purchaseState === 'purchased') {
          const ok = await finish(purchase).then(
            () => true,
            () => false,
          );
          if (ok) {
            finished.push({
              productId: purchase.productId,
              transactionId: transactionIdOf(purchase),
            });
          }
        }
      }
      return finished;
    },

    async disconnect() {
      if (!connected) return;
      connected = false;
      shared.users--;
      if (shared.users > 0) return;
      shared.opening = null;
      await iap.endConnection().catch(() => false);
    },
  };
}

/**
 * Consume tips an earlier session left unfinished — a purchase whose app was
 * killed before the consume, or an Android pending payment that cleared while
 * the app was closed (Play refunds what stays unacknowledged for three days).
 * Run once at launch; silent, and a no-op without a store.
 */
export async function sweepUnfinishedTips(
  onFinished: (tip: FinishedTip) => void = () => undefined,
): Promise<void> {
  const store = getTipStore();
  if (store === null) return;
  try {
    if (await store.connect()) {
      for (const tip of await store.sweepUnfinished()) onFinished(tip);
    }
  } catch {
    // Retried at the next launch or Support visit.
  } finally {
    await store.disconnect();
  }
}

/**
 * The device's tip store, or null when this build/device has none. A
 * `__DEV__`-only fake (`EXPO_PUBLIC_IAP_MOCK=1`) lets the product list be
 * seen on an emulator; release bundles strip it.
 */
export function getTipStore(): TipStore | null {
  if (__DEV__ && process.env.EXPO_PUBLIC_IAP_MOCK === '1') return createDevTipStore();
  const iap = loadExpoIap();
  return iap === null ? null : createTipStore(iap);
}

/** Emulator-only fake: US prices, and every purchase succeeds after a beat. */
function createDevTipStore(): TipStore {
  const prices: Record<string, string> = {
    tip_small: '$2.99',
    tip_medium: '$6.99',
    tip_large: '$14.99',
    tip_xlarge: '$29.99',
    tip_patron: '$99.99',
  };
  let emit: ((event: TipEvent) => void) | null = null;
  return {
    connect: async () => true,
    fetchTips: async (ids) =>
      ids.flatMap((id) => {
        const displayPrice = prices[id];
        return displayPrice === undefined ? [] : [{ id, displayPrice }];
      }),
    requestTip: async (id) => {
      setTimeout(
        () => emit?.({ kind: 'purchased', productId: id, transactionId: `dev-${Date.now()}` }),
        600,
      );
    },
    subscribe: (listener) => {
      emit = listener;
      return () => {
        emit = null;
      };
    },
    sweepUnfinished: async () => [],
    disconnect: async () => undefined,
  };
}
