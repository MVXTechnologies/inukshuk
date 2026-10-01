import {
  ALWAYS_PRESENT_ANCHORS,
  CONTOURS_ANCHOR,
  DRAPE_ANCHORS_BOTTOM_TO_TOP,
  drapeAnchorLayer,
  MARINE_DRAPE_ANCHOR,
  MARINE_SOUNDINGS_ANCHOR,
  PDF_MAPS_ANCHOR,
  TERRAIN_OVERLAY_ANCHOR,
  TRAILS_ANCHOR,
  WEATHER_DRAPE_ANCHOR,
} from './mapLayerStack';

describe('drape anchors', () => {
  it('gives every drape slot its OWN anchor — a shared one makes mount order the z-order', () => {
    // `style.addLayerBelow(layer, anchor)` inserts immediately below the
    // anchor, so two children naming the same anchor swap places depending on
    // which was re-inserted last (every style reload re-adds them). Distinct
    // anchors are what makes the order a property of the style.
    const ids = [...DRAPE_ANCHORS_BOTTOM_TO_TOP];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });

  it('orders them bottom → top: marine drape under the weather field under the soundings', () => {
    const order = [...DRAPE_ANCHORS_BOTTOM_TO_TOP];
    expect(order.indexOf(WEATHER_DRAPE_ANCHOR)).toBeGreaterThan(order.indexOf(MARINE_DRAPE_ANCHOR));
    // The depth numbers must stay readable over a 62%-opaque colour field.
    expect(order.indexOf(MARINE_SOUNDINGS_ANCHOR)).toBeGreaterThan(
      order.indexOf(WEATHER_DRAPE_ANCHOR),
    );
  });

  it('renders each anchor as an invisible, sourceless background layer', () => {
    for (const id of DRAPE_ANCHORS_BOTTOM_TO_TOP) {
      const layer = drapeAnchorLayer(id);
      expect(layer).toEqual({ id, type: 'background', layout: { visibility: 'none' } });
      // No `source`: a marker must never be able to paint or fetch anything.
      expect('source' in layer).toBe(false);
      expect('paint' in layer).toBe(false);
    }
  });
});

// #332 — the position puck rendered beneath PDF maps: overlays added as
// MapView children after first paint were appended ABOVE the puck. These
// anchors give every such layer a fixed slot below it.
describe('overlay anchors below the position puck (#332)', () => {
  it('stacks contours under the slope under PDF maps under trails (#492)', () => {
    const order: readonly string[] = DRAPE_ANCHORS_BOTTOM_TO_TOP;
    const at = (id: string) => order.indexOf(id);
    // The owner's report: contours drew OVER the PDF maps on satellite.
    expect(at(PDF_MAPS_ANCHOR)).toBeGreaterThan(at(CONTOURS_ANCHOR));
    expect(at(PDF_MAPS_ANCHOR)).toBeGreaterThan(at(TERRAIN_OVERLAY_ANCHOR));
    expect(at(TERRAIN_OVERLAY_ANCHOR)).toBeGreaterThan(at(CONTOURS_ANCHOR));
    // The drapes stay under the PDF maps, and the trails top everything.
    expect(at(PDF_MAPS_ANCHOR)).toBeGreaterThan(at(MARINE_SOUNDINGS_ANCHOR));
    expect(at(TRAILS_ANCHOR)).toBeGreaterThan(at(PDF_MAPS_ANCHOR));
    expect(order[order.length - 1]).toBe(TRAILS_ANCHOR);
  });

  it('the always-present anchors are the four the runtime overlays depend on', () => {
    expect([...ALWAYS_PRESENT_ANCHORS]).toEqual([
      CONTOURS_ANCHOR,
      TERRAIN_OVERLAY_ANCHOR,
      PDF_MAPS_ANCHOR,
      TRAILS_ANCHOR,
    ]);
    for (const id of ALWAYS_PRESENT_ANCHORS) expect(DRAPE_ANCHORS_BOTTOM_TO_TOP).toContain(id);
  });
});
