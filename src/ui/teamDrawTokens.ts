import { palette, type SchemeTokens } from './tokens';

/**
 * Team drawing's colours (#683, mockups 252). The tool bar and the top bar
 * are the fixed dark map-chrome slab (like the + menu and the compass), the
 * same in both themes, while the map under them follows the theme; the
 * drawn halo and selection follow the theme.
 */
export const drawChrome = {
  /** The bottom tool bar. */
  bar: 'rgba(31,35,40,0.97)',
  barInk: 'rgba(255,255,255,0.92)',
  barInkMuted: 'rgba(255,255,255,0.75)',
  barDivider: 'rgba(255,255,255,0.18)',
  barOutline: 'rgba(255,255,255,0.22)',
  /** The active tool and Done. */
  active: '#B6C98A',
  onActive: '#28340A',
  activeSoft: 'rgba(182,201,138,0.14)',
  /** A tool bar button whose panel is open (not the current tool). */
  openInk: '#DDE8C2',
  /** The readout chip over the map while drawing. */
  chip: 'rgba(24,27,31,0.9)',
  chipInk: 'rgba(255,255,255,0.95)',
  chipInkMuted: 'rgba(255,255,255,0.62)',
  /** Text on a badge (on a member colour). */
  onBadge: palette.white,
} as const;

/** Halo and selection colours on the map for the scheme. */
export function drawMapColors(t: SchemeTokens, dark: boolean) {
  return {
    halo: dark ? '#13171B' : palette.surface,
    selection: dark ? 'rgba(182,201,138,0.42)' : 'rgba(86,107,51,0.38)',
    ink: t.team.mapInk,
    onBadge: drawChrome.onBadge,
  };
}
