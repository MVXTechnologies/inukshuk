import { STACK_GAP_DP, stackOffsets } from '@core/infoStrip/layout';
import type { Dock } from '@core/infoStrip/types';
import type { HeroField } from '@core/recording/panel';
import { create } from 'zustand';

/**
 * The info strip's live, unsaved state (#673), shared by the few leaves that
 * need it — a store, not MapScreen state, so none of it re-renders the map
 * screen except the one number MapScreen lifts its bottom column by:
 *
 * - `dock` / `stripH`: where the strip is and its MEASURED height (0 while it
 *   shows nothing), written on layout, so they change only when the rows
 *   or the dock do. What they lift is the core rule (`stackOffsets`):
 *   MapScreen lifts its bottom column by `useInfoStripBottomLift`;
 *   `InfoStripInsets` shifts the top chrome by `useInfoStripTopShift`.
 * - `heroFields`: the metrics the recording panel's hero row shows right now
 *   (empty while it is minimised or not up), for the strip's de-dup rule.
 * - `stripMetrics`: the hero metrics the strip shows, so cycling a hero slot
 *   skips them.
 * - `onPanel`: the strip sits on the recording panel (the panel squares its
 *   top, the strip takes the rounded one).
 * - `editorOpen`: the editor is open (a long-press on the strip, or Map layers).
 */
export interface StripRuntime {
  dock: Dock;
  stripH: number;
  heroFields: readonly HeroField[];
  stripMetrics: ReadonlySet<HeroField>;
  onPanel: boolean;
  editorOpen: boolean;
}

const INITIAL: StripRuntime = {
  dock: 'bottom',
  stripH: 0,
  heroFields: [],
  stripMetrics: new Set(),
  onPanel: false,
  editorOpen: false,
};

export const useStripRuntime = create<StripRuntime>(() => ({ ...INITIAL }));

/** Set a runtime value; a value equal to the current one notifies nobody. */
export function setStripRuntime(patch: Partial<StripRuntime>): void {
  const s = useStripRuntime.getState();
  const changed = (Object.keys(patch) as (keyof StripRuntime)[]).some((k) => {
    const a = s[k];
    const b = patch[k];
    if (a instanceof Set && b instanceof Set) {
      return a.size !== b.size || [...a].some((x) => !b.has(x));
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length !== b.length || a.some((x, i) => x !== b[i]);
    }
    return !Object.is(a, b);
  });
  if (changed) useStripRuntime.setState(patch);
}

export const openStripEditor = () => setStripRuntime({ editorOpen: true });
/** Whether the editor is open (re-renders only on open and close). */
export const useStripEditorOpen = (): boolean => useStripRuntime((s) => s.editorOpen);
export const closeStripEditor = () => setStripRuntime({ editorOpen: false });

/** Tests: back to the initial state. */
export function resetStripRuntime(): void {
  useStripRuntime.setState({ ...INITIAL, stripMetrics: new Set() });
}

/**
 * How far the bottom column (the compass tape, then the ⓘ + scale row above
 * it) rides up for the strip, over whatever lifts it already: what
 * `stackOffsets` puts between the panel (or tab bar) and the tape.
 */
export function bottomLiftOf(s: Pick<StripRuntime, 'dock' | 'stripH'>): number {
  const o = stackOffsets(s.dock, s.stripH, 0, true);
  return o.tapeBottom! - STACK_GAP_DP;
}

/**
 * A top-docked strip's measured height (`stackOffsets`), status bar included:
 * `InfoStripInsets` moves the top chrome by the part below the status bar
 * (`topChromeShiftDp`).
 */
export function topShiftOf(s: Pick<StripRuntime, 'dock' | 'stripH'>): number {
  return stackOffsets(s.dock, s.stripH, 0, false).topChromeShift;
}

/** MapScreen: how far the bottom column rides up for a bottom-docked strip. */
export const useInfoStripBottomLift = (): number => useStripRuntime(bottomLiftOf);
/** `InfoStripInsets`: the top-docked strip's height (0 at the bottom), status bar included. */
export const useInfoStripTopShift = (): number => useStripRuntime(topShiftOf);
