import { createSettleThrottle } from '@core/map/settleThrottle';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isHeadingMoving } from '../headingMotion';

/** While the compass turns the camera, at most this many settles per second reach the screen. */
export const HEADING_SETTLE_INTERVAL_MS = 400;

interface SettleEvent {
  nativeEvent: { userInteraction?: boolean };
}

/**
 * Wraps the map's `onRegionDidChange` handler so the camera settles that the
 * compass itself produces — one per animation frame in heading-up (see
 * `useHeadingCamera`) — reach it at most every `HEADING_SETTLE_INTERVAL_MS`,
 * plus the last one. A person's gesture, and any settle while the heading is
 * at rest, is handled at once (`@core/map/settleThrottle`).
 *
 * The held event is handed to the LATEST handler when its time comes (the
 * handler closes over render state; a stale one must not run).
 */
export function useSettleThrottle<E extends SettleEvent>(handler: (e: E) => void): (e: E) => void {
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  });
  const [throttle] = useState(() => createSettleThrottle(HEADING_SETTLE_INTERVAL_MS));
  const heldRef = useRef<E | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  return useCallback(
    (e: E) => {
      const streaming = e.nativeEvent.userInteraction !== true && isHeadingMoving();
      const decision = throttle.push(Date.now(), streaming);
      if (decision.kind === 'run') {
        heldRef.current = null;
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = null;
        handlerRef.current(e);
        return;
      }
      heldRef.current = e;
      if (timerRef.current !== null) return;
      timerRef.current = setTimeout(function fire() {
        timerRef.current = null;
        const held = heldRef.current;
        if (held === null) return;
        if (throttle.flush(Date.now())) {
          heldRef.current = null;
          handlerRef.current(held);
        } else if (throttle.holding()) {
          timerRef.current = setTimeout(fire, HEADING_SETTLE_INTERVAL_MS);
        }
      }, decision.inMs);
    },
    [throttle],
  );
}
