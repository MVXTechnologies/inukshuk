import { createContext, useMemo, type ReactNode } from 'react';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useInfoStripTopShift } from './stripRuntime';

/** The device's real top inset (the status bar), for the top-docked strip itself. */
export const RealTopInsetContext = createContext(0);

/**
 * The top dock (#673, mockup §5): the strip takes the top edge, and EVERY
 * piece of top chrome — compass badge, search, rail, destination chip,
 * banners, cards that pad by the safe area — moves down by its measured
 * height. One provider instead of a hundred `insets.top` edits: under it,
 * the safe area's top inset includes the strip. The strip reads the real one
 * from {@link RealTopInsetContext}.
 *
 * Re-renders its subtree only when the strip's top height changes (rows
 * added or removed, the dock switched), never per tick.
 */
export function InfoStripInsets({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const shift = useInfoStripTopShift();
  const shifted = useMemo(
    () => (shift > 0 ? { ...insets, top: insets.top + shift } : insets),
    [insets, shift],
  );
  return (
    <RealTopInsetContext.Provider value={insets.top}>
      <SafeAreaInsetsContext.Provider value={shifted}>{children}</SafeAreaInsetsContext.Provider>
    </RealTopInsetContext.Provider>
  );
}
