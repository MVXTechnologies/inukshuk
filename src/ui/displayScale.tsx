import {
  displayScaleFactor,
  hitSlopFor,
  scaleSheet,
  scaleSize,
  scaleSpacing,
  touchSize,
} from '@core/display/displayScale';
import { useSettingsStore } from '@state/settingsStore';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * Display size (#760) for React: the factor flows through a context so a
 * subtree can preview another size (Settings rescales itself while the
 * slider is dragged) without touching the rest of the app.
 *
 * The root `DisplayScaleProvider` (no `factor`) reads the persisted setting;
 * a nested one with `factor` overrides it for its children.
 */
const DisplayScaleContext = createContext<number | null>(null);

export function DisplayScaleProvider({
  factor,
  children,
}: {
  /** An override (the live preview); omitted, the saved Display size. */
  factor?: number;
  children: ReactNode;
}) {
  const saved = displayScaleFactor(useSettingsStore((s) => s.displayScale));
  return (
    <DisplayScaleContext.Provider value={factor ?? saved}>{children}</DisplayScaleContext.Provider>
  );
}

/** The helpers a component sizes itself with at the current Display size. */
export interface DisplayScaleApi {
  /** The multiplier: 0.6 … 1.5, 1 at 100 %. */
  factor: number;
  /** A content size (text, icon, box) in dp at the current scale (`sz(40)` → 34 at Small). */
  sz: (n: number) => number;
  /** A padding, margin, gap or edge offset: denser than content (`sp(16)` → 12.5 at Small). */
  sp: (n: number) => number;
  /** A touchable box's side: scaled, never below 48. */
  touch: (n: number) => number;
  /** The hitSlop that grows a scaled `n`-dp visual to a 48 dp target. */
  slop: (n: number) => number;
}

/**
 * The factor in effect here. Outside any provider (tests, isolated renders)
 * it reads the saved setting, so a component never needs a provider to work.
 */
export function useDisplayFactor(): number {
  const ctx = useContext(DisplayScaleContext);
  const saved = displayScaleFactor(useSettingsStore((s) => s.displayScale));
  return ctx ?? saved;
}

export function useDisplayScale(): DisplayScaleApi {
  const factor = useDisplayFactor();
  return useMemo(
    () => ({
      factor,
      sz: (n: number) => scaleSize(n, factor),
      sp: (n: number) => scaleSpacing(n, factor),
      touch: (n: number) => touchSize(n, factor),
      slop: (n: number) => hitSlopFor(scaleSize(n, factor)),
    }),
    [factor],
  );
}

/**
 * A module-level `StyleSheet.create` sheet at the current Display size:
 * sizes scaled, touch-sized minimums kept at 48, memoised per factor. The
 * same object at 100 %.
 *
 *   const sheet = StyleSheet.create({ row: { padding: 12 } });
 *   function Row() { const styles = useScaledStyles(sheet); … }
 */
export function useScaledStyles<T extends object>(sheet: T): T {
  return scaleSheet(sheet, useDisplayFactor());
}
