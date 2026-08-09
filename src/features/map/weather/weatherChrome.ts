/**
 * Weather-surface chrome (weather UX M1 polish, the Windy idiom): the
 * scrubber bar, legend pill and layer picker float over map tiles, not
 * themed surfaces — so, like the edge rail's pill slab (`edgePill` in
 * `@ui/theme`), they wear ONE fixed dark translucent look in BOTH colour
 * schemes. The accent is our sage green in its dark-surface lift (the dark
 * theme's own primary), so the brand green survives on the slab where the
 * light theme's deep foliage would vanish.
 */
export const weatherChrome = {
  /** Translucent slab behind the scrubber bar and legend pill. */
  panel: 'rgba(24, 27, 31, 0.9)',
  /** Near-opaque slab for the layer-picker dialog. */
  panelSolid: 'rgba(31, 35, 40, 0.97)',
  /** Primary text/icons on the slab. */
  ink: 'rgba(255, 255, 255, 0.95)',
  /** Secondary text (day ticks, hints, units). */
  inkMuted: 'rgba(255, 255, 255, 0.62)',
  /** Disabled/faint (placeholder chevron, minor ticks). */
  inkFaint: 'rgba(255, 255, 255, 0.36)',
  /** Hairlines (dividers, tick baseline). */
  hairline: 'rgba(255, 255, 255, 0.14)',
  /** Sage accent on the dark slab (== dark theme primary). */
  accent: '#B6C98A',
  /** Ink on the accent (== dark theme onPrimary — AA-checked pairing). */
  onAccent: '#28340A',
  /** The round play button: white disc, deep-foliage glyph (Windy's white disc idiom). */
  playDisc: '#FFFFFF',
  onPlayDisc: '#566B33',
} as const;
