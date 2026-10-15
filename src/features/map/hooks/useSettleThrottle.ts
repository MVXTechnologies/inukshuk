import { parseRegionPayload, type RegionPayload } from '@core/map/regionPayload';
import { createSettleThrottle } from '@core/map/settleThrottle';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isHeadingMoving } from '../headingMotion';

/** While the compass turns the camera, at most this many settles per second reach the screen. */
export const HEADING_SETTLE_INTERVAL_MS = 400;

/** What the throttle needs of a settle: whether a person moved the camera. */
interface Settle {
  userInteraction: boolean;
}

/**
 * Wraps the map's `onRegionDidChange` handler so the camera settles that the
 * compass itself produces — one per animation frame in heading-up (see
 * `useHeadingCamera`) — reach it at most every `HEADING_SETTLE_INTERVAL_MS`,
 * plus the last one. A person's gesture, and any settle while the heading is
 * at rest, is handled at once (`@core/map/settleThrottle`).
 *
 * It takes the PARSED payload (`@core/map/regionPayload`), never the
 * React Native event: RN pools synthetic events and nulls `nativeEvent` once
 * the handler returns, so an event held for the trailing call reads null
 * (2.6.1 QA white screen). The held payload is handed to the LATEST handler
 * when its time comes (the handler closes over render state; a stale one
 * must not run).
 */
export function useSettleThrottle<E extends Settle>(handler: (e: E) => void): (e: E) => void {
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
      const streaming = !e.userInteraction && isHeadingMoving();
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

/**
 * The map's `onRegionDidChange`, end to end: parses the event's payload AT
 * ONCE (`parseRegionPayload` — React Native pools the event and nulls its
 * `nativeEvent` as soon as the handler returns), drops an unusable one
 * (MapLibre sends an empty view before the camera has a target), and hands
 * the parsed view to `onSettled` through `useSettleThrottle`. Returns the
 * parsed view (or null) for what must see every settle unthrottled.
 */
export function useRegionSettle(
  onSettled: (view: RegionPayload) => void,
): (e: { nativeEvent: unknown }) => RegionPayload | null {
  const throttled = useSettleThrottle(onSettled);
  return useCallback(
    (e: { nativeEvent: unknown }) => {
      const view = parseRegionPayload(e.nativeEvent);
      if (view !== null) throttled(view);
      return view;
    },
    [throttled],
  );
}
