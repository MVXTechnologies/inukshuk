import { STRIP_BAND_RIGHT, STRIP_BAND_RIGHT_BESIDE_SOS } from '@core/teamui/alertBands';

import {
  MAP_BUTTON,
  MAP_COLUMN_AXIS,
  MAP_EDGE_INSET,
  MAP_LANE_GAP,
  MAP_LANE_INSET,
  MAP_STACK_GAP,
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
