import { TIP_IDS, tipOffers } from '@core/support/tips';
import { getTipStore } from '@lib/iap';
import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Whether the store can actually take a tip on this device: the billing
 * module is in the build, it connects, and at least one tip product comes
 * back. Until the store accounts are set up (Apple Paid Apps agreement, Play
 * payments profile, the four products), none does — and the map's coffee mug
 * must not offer a tip that can't be paid (App Review rejects dead buttons).
 *
 * Probed once per app session, quietly; the mug stays hidden until 'yes'.
 */
export type TipsAvailability = 'unknown' | 'yes' | 'no';

const PROBE_TIMEOUT_MS = 10_000;

export const useTipsAvailability = create<{ state: TipsAvailability }>(() => ({
  state: 'unknown',
}));

let probing: Promise<void> | null = null;

/**
 * `p`, or `fallback` if it rejects or takes longer than PROBE_TIMEOUT_MS. The
 * timer is cleared as soon as `p` settles: a 10 s timer left pending after
 * every probe kept Jest workers alive past the suite ("A worker process has
 * failed to exit gracefully") and held a timer in the app for nothing.
 */
function settle<T>(p: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), PROBE_TIMEOUT_MS);
  });
  return Promise.race([p.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

/** Run the probe (once). Exported for tests. */
export function probeTipsAvailability(): Promise<void> {
  probing ??= (async () => {
    const store = getTipStore();
    if (store === null) {
      useTipsAvailability.setState({ state: 'no' });
      return;
    }
    const connected = await settle(store.connect(), false);
    const products = connected ? await settle(store.fetchTips(TIP_IDS), []) : [];
    useTipsAvailability.setState({ state: tipOffers(products).length > 0 ? 'yes' : 'no' });
    void store.disconnect().catch(() => undefined);
  })();
  return probing;
}

/** Test hook: forget the cached probe. */
export function resetTipsAvailabilityForTests(): void {
  probing = null;
  useTipsAvailability.setState({ state: 'unknown' });
}

/** True once the store has confirmed it can sell at least one tip. */
export function useTipsAvailable(): boolean {
  const state = useTipsAvailability((s) => s.state);
  useEffect(() => {
    void probeTipsAvailability();
  }, []);
  return state === 'yes';
}
