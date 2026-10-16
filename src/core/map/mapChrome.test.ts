import { DISPLAY_SCALES, scaleSize } from '@core/display/displayScale';
import { STRIP_BAND_RIGHT, STRIP_BAND_RIGHT_BESIDE_SOS } from '@core/teamui/alertBands';

import {
  MAP_BUTTON,
  MAP_BUTTON_DISC,
  MAP_COLUMN_AXIS,
  MAP_EDGE_INSET,
  MAP_LANE_GAP,
  MAP_LANE_INSET,
  MAP_STACK_GAP,
  mapChromeAt,
  onColumnRight,
} from './mapChrome';

describe('map chrome metrics (#756)', () => {
  it('the top-centre lane starts past an edge column and its gap (76 dp)', () => {
    expect(MAP_LANE_INSET).toBe(MAP_EDGE_INSET + MAP_BUTTON + MAP_LANE_GAP);
    expect(MAP_LANE_INSET).toBe(76);
  });

  it('a column button is centred 40 dp from its edge, 48 dp wide, 8 dp apart', () => {
    expect(MAP_COLUMN_AXIS).toBe(40);
    expect(MAP_BUTTON).toBeGreaterThanOrEqual(48);
    expect(MAP_STACK_GAP).toBe(8);
  });

  it('the SOS strip band clears the rail column (and its ring) with the lane inset', () => {
    expect(STRIP_BAND_RIGHT_BESIDE_SOS).toBe(MAP_LANE_INSET);
    expect(STRIP_BAND_RIGHT).toBe(MAP_EDGE_INSET);
  });
});

describe('map chrome at a Display size (#760)', () => {
  it('is the constants at 100 %, with 40 dp discs in touching 48 dp boxes', () => {
    expect(MAP_BUTTON_DISC).toBe(40);
    expect(mapChromeAt(1)).toEqual({
      edgeInset: MAP_EDGE_INSET,
      disc: 40,
      button: MAP_BUTTON,
      stackGap: MAP_STACK_GAP,
      railGap: 0,
      columnAxis: MAP_COLUMN_AXIS,
      laneGap: MAP_LANE_GAP,
      laneInset: MAP_LANE_INSET,
    });
  });

  it.each(DISPLAY_SCALES.map((k) => [k]))('at %p: touch ≥ 48, discs a stack gap apart', (k) => {
    const m = mapChromeAt(k);
    expect(m.button).toBeGreaterThanOrEqual(48);
    expect(m.button + m.railGap - m.disc).toBeGreaterThanOrEqual(m.stackGap);
  });

  it.each(DISPLAY_SCALES.map((k) => [k]))('at %p the SOS ring sits on the rail axis', (k) => {
    const m = mapChromeAt(k);
    const ring = scaleSize(56, k);
    expect(onColumnRight(m, ring) + ring / 2).toBe(m.columnAxis);
    expect(m.edgeInset + m.button / 2).toBe(m.columnAxis);
  });

  it('Small is denser and Large roomier, the lane following the column', () => {
    const all = DISPLAY_SCALES.map(mapChromeAt);
    const [s, d, l] = all;
    expect(s?.edgeInset).toBeLessThan(d?.edgeInset ?? 0);
    expect(l?.edgeInset).toBeGreaterThan(d?.edgeInset ?? 0);
    for (const m of all) expect(m.laneInset).toBe(m.edgeInset + m.button + m.laneGap);
  });
});
