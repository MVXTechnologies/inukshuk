import { topChromeShiftDp } from '@core/infoStrip/layout';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  SafeAreaInsetsContext,
  useSafeAreaInsets,
  type EdgeInsets,
} from 'react-native-safe-area-context';

import { useInfoStripTopShift } from './stripRuntime';

/** The device's real insets, unshifted; null outside {@link InfoStripInsets}. */
const RealInsetsContext = createContext<EdgeInsets | null>(null);

/**
 * The device's REAL safe-area insets, whatever the top-docked strip shifted:
 * for the strip itself (its surface reaches behind the status bar) and for
 * anything full screen in its own window — a photo viewer's close button
 * belongs under the status bar, not under a strip it does not sit on. The
 * plain safe area outside the Map route.
 */
export function useRealSafeAreaInsets(): EdgeInsets {
  const real = useContext(RealInsetsContext);
  const insets = useSafeAreaInsets();
  return real ?? insets;
}

/**
 * The top dock (#673, mockup §5): the strip takes the top edge, and EVERY
 * piece of top chrome — compass badge, search, rail, destination chip,
 * banners, cards that pad by the safe area — moves down by it. One provider
 * instead of a hundred `insets.top` edits: under it, the safe area's top
 * inset is the strip's bottom edge. The strip reads the real one from
 * {@link useRealSafeAreaInsets}.
 *
 * The strip's measured height already includes the status bar it reaches
 * behind, so the top inset becomes that height, never the status bar plus it
 * (`topChromeShiftDp`).
 *
 * Re-renders its subtree only when the strip's top height changes (rows
 * added or removed, the dock switched), never per tick.
 */
export function InfoStripInsets({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const shift = topChromeShiftDp(useInfoStripTopShift(), insets.top);
  const shifted = useMemo(
    () => (shift > 0 ? { ...insets, top: insets.top + shift } : insets),
    [insets, shift],
  );
  return (
    <RealInsetsContext.Provider value={insets}>
      <SafeAreaInsetsContext.Provider value={shifted}>{children}</SafeAreaInsetsContext.Provider>
    </RealInsetsContext.Provider>
  );
}
