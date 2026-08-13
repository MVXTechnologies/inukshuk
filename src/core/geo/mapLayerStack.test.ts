import {
  DRAPE_ANCHORS_BOTTOM_TO_TOP,
  drapeAnchorLayer,
  MARINE_DRAPE_ANCHOR,
  MARINE_SOUNDINGS_ANCHOR,
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
