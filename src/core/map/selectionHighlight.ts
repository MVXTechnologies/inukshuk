/**
 * The selected trail's highlight (#747, owner pick "Option 1 · bright
 * casing"): the line itself at 5 dp in its own colour, over a white casing
 * (9 dp) wrapped in a soft cyan glow. Every other trail stays drawn as usual
 * around it. One spec for the main map's trails and the team trails, so a
 * tapped trail reads the same in both modes.
 *
 * The ground decides the tints (paper map = light, night map and imagery =
 * dark): a pure-white casing glares on the night map, so it is a cool
 * off-white there, and the glow a touch brighter.
 *
 * Plain numbers and colours only — no `["zoom"]` and no data-driven case
 * (MapLibre iOS crashes on a zoom expression nested in match/case), so the
 * layers stay as cheap as the ordinary trail lines.
 *
 * PURE: no React Native / Expo imports.
 */

export type HighlightGround = 'paper' | 'night' | 'imagery';

export interface SelectionHighlightSpec {
  line: { width: number };
  casing: { color: string; width: number };
  glow: { color: string; opacity: number; width: number; blur: number };
}

/** Line width of the selected trail (dp). */
export const HIGHLIGHT_LINE_W = 5;
/** White casing under it (dp). */
export const HIGHLIGHT_CASING_W = 9;
/** The glow's total width (dp): ~5 dp of soft cyan each side of the line. */
export const HIGHLIGHT_GLOW_W = 15;

const LIGHT = { casing: '#FFFFFF', glow: '#00BEE6' } as const;
const DARK = { casing: '#E9FBFF', glow: '#00C8F0' } as const;

export function selectionHighlight(ground: HighlightGround): SelectionHighlightSpec {
  const tint = ground === 'paper' ? LIGHT : DARK;
  return {
    line: { width: HIGHLIGHT_LINE_W },
    casing: { color: tint.casing, width: HIGHLIGHT_CASING_W },
    glow: { color: tint.glow, opacity: 0.55, width: HIGHLIGHT_GLOW_W, blur: 6 },
  };
}
