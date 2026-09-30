/**
 * Screen padding (dp) for framing a long-distance trail or stage on the main
 * map (#472): clear of the status bar and the trail's name pill at the top,
 * the controls rail on the right (16 + 48 dp and a margin — the Library's
 * default 60 put a trail's end under it) and the stage sheet at the bottom.
 */
export const TRAIL_FOCUS_PADDING = { top: 130, right: 88, bottom: 240, left: 44 } as const;
