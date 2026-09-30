import {
  classifyTipFailure,
  defaultTipId,
  TIP_IDS,
  tipFailureMessage,
  tipOffers,
  type TipId,
  type TipOffer,
} from '@core/support/tips';
import { reportError } from '@lib/errorReporting';
import { getTipStore, type TipEvent, type TipStore } from '@lib/iap';
import { useSettingsStore } from '@state/settingsStore';
import { useSupportStore } from '@state/supportStore';
import { restUntil } from '@core/support/verify';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The tip jar's state machine (#476) over the store adapter:
 *
 *   loading → ready (offers with store prices) | unavailable
 *   ready: select → buy → (store sheet) → thanks | pending notice | error notice | nothing (cancel)
 *
 * "Unavailable" is a calm, final state: no native module in this build, no
 * billing on the device, no products returned (a simulator, a storefront
 * where the tips are not sold) or a store that did not answer in time. It is
 * never an error dialog.
 */

/** A store that never answers must not leave a spinner on screen. */
export const STORE_TIMEOUT_MS = 10_000;
/** A purchase sheet that never reports back (rare) frees the button eventually. */
export const PURCHASE_TIMEOUT_MS = 3 * 60_000;

export type TipJarPhase = 'loading' | 'ready' | 'unavailable';

export interface TipJar {
  phase: TipJarPhase;
  offers: TipOffer[];
  selected: TipId | null;
  select: (id: TipId) => void;
  /** Tip the selected tier. */
  buy: () => void;
  /** True from the tap until the store reports an outcome. */
  buying: boolean;
  /** One calm sentence after a pending or failed tip (null = nothing to say). */
  notice: string | null;
}

function withTimeout<T>(promise: Promise<T>, fallback: T, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function useTipJar(onThanks: (productId: string) => void): TipJar {
  // Resolved once per mount: a build without the store is unavailable from the first frame.
  const [store] = useState<TipStore | null>(getTipStore);
  const [phase, setPhase] = useState<TipJarPhase>(store === null ? 'unavailable' : 'loading');
  const [offers, setOffers] = useState<TipOffer[]>([]);
  const [selected, setSelected] = useState<TipId | null>(null);
  const [buying, setBuying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const onThanksRef = useRef(onThanks);
  useEffect(() => {
    onThanksRef.current = onThanks;
  }, [onThanks]);
  const buyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const settle = useCallback(() => {
    if (buyTimer.current !== null) clearTimeout(buyTimer.current);
    buyTimer.current = null;
    setBuying(false);
  }, []);

  const onEvent = useCallback(
    (event: TipEvent) => {
      settle();
      if (event.kind === 'purchased') {
        // Counted before the thank-you screen reads the total (donors offer).
        useSupportStore.getState().recordTip(event);
        // Thanked people are not asked again for a year (then the button returns).
        useSettingsStore.getState().set('tipJarRestingUntil', restUntil(Date.now()));
        setNotice(null);
        onThanksRef.current(event.productId);
        return;
      }
      if (event.kind === 'pending') {
        setNotice(tipFailureMessage('pending'));
        return;
      }
      const failure = classifyTipFailure(event.code);
      if (failure === 'failed')
        reportError(new Error(`tip failed: ${event.code ?? '?'} ${event.message}`), 'tip');
      setNotice(tipFailureMessage(failure));
    },
    [settle],
  );

  useEffect(() => {
    if (store === null) return;
    let alive = true;
    const unsubscribe = store.subscribe((event) => {
      if (alive) onEvent(event);
    });
    (async () => {
      const connected = await withTimeout(store.connect(), false, STORE_TIMEOUT_MS);
      if (!alive) return;
      if (!connected) {
        setPhase('unavailable');
        return;
      }
      const products = await withTimeout(store.fetchTips(TIP_IDS), [], STORE_TIMEOUT_MS);
      if (!alive) return;
      const available = tipOffers(products);
      setOffers(available);
      setSelected(defaultTipId(available));
      setPhase(available.length > 0 ? 'ready' : 'unavailable');
      // Consume anything an earlier session left unfinished (quietly).
      store
        .sweepUnfinished()
        .then((finished) => finished.forEach((tip) => useSupportStore.getState().recordTip(tip)))
        .catch(() => undefined);
    })().catch(() => {
      if (alive) setPhase('unavailable');
    });
    return () => {
      alive = false;
      unsubscribe();
      if (buyTimer.current !== null) clearTimeout(buyTimer.current);
      void store.disconnect();
    };
  }, [onEvent, store]);

  const buy = useCallback(() => {
    if (store === null || selected === null || buying) return;
    setBuying(true);
    setNotice(null);
    buyTimer.current = setTimeout(settle, PURCHASE_TIMEOUT_MS);
    store.requestTip(selected).catch((error: unknown) => {
      const e = (typeof error === 'object' && error !== null ? error : {}) as {
        code?: unknown;
        message?: unknown;
      };
      onEvent({
        kind: 'error',
        code: typeof e.code === 'string' ? e.code : null,
        message: typeof e.message === 'string' ? e.message : String(error),
      });
    });
  }, [buying, onEvent, selected, settle, store]);

  return { phase, offers, selected, select: setSelected, buy, buying, notice };
}
