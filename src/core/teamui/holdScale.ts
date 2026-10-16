/**
 * The SOS button's swell while it is held (owner, #756 follow-up): it grows
 * from 1× to {@link HOLD_SCALE_MAX} over the hold, eased in and out, so the
 * finger feels the SOS arming; let go early and it springs back; past the
 * hold it settles back as the SOS arms. The scale is a pure function of the
 * hold's progress (0–1), a worklet the UI thread runs each frame from a
 * shared value: no JS state per frame. PURE.
 */

/** The size at a complete hold. */
export const HOLD_SCALE_MAX = 1.35;

/** Ease in and out (cubic) on [0, 1]. */
function easeInOutCubic(p: number): number {
  'worklet';
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

/** The button's scale at hold `progress` (clamped to 0–1; 1× at rest). */
export function holdScale(progress: number): number {
  'worklet';
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return 1 + (HOLD_SCALE_MAX - 1) * easeInOutCubic(p);
}
