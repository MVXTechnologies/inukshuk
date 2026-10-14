import { DRAW_TAP_LAYERS } from '@core/teamdraw/mapStyle';

/** A finger's width around the tap, px. */
const HIT_PX = 16;

interface Queryable {
  queryRenderedFeatures: (
    box: [[number, number], [number, number]],
    options: { layers: string[] },
  ) => Promise<unknown[]>;
}

/**
 * The finished drawing under a tap (#683), as its key `owner:id`, or null.
 * Live strokes are not tappable. The newest shape wins (MapLibre returns the
 * topmost first).
 */
export async function hitTestTeamDraw(
  map: Queryable,
  px: number,
  py: number,
): Promise<string | null> {
  try {
    const found = await map.queryRenderedFeatures(
      [
        [px - HIT_PX, py - HIT_PX],
        [px + HIT_PX, py + HIT_PX],
      ],
      { layers: DRAW_TAP_LAYERS },
    );
    for (const f of found) {
      const p = (f as { properties?: Record<string, unknown> }).properties ?? {};
      if (p['live'] === true) continue;
      if (typeof p['drw'] === 'string') return p['drw'];
    }
  } catch {
    // Layers absent (no drawings, team off) or the map mid-teardown.
  }
  return null;
}
