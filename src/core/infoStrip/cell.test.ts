import { haversineMeters } from '@core/geo/geomath';

import { cellOf, LIST_CELL_DEG } from './cell';

const QC = { latitude: 46.81394, longitude: -71.20761 };

describe('position cells', () => {
  it('a few metres keep the cell; ~50 m changes it', () => {
    const a = cellOf(QC, LIST_CELL_DEG);
    const step = { latitude: QC.latitude + 0.00001, longitude: QC.longitude };
    expect(cellOf(step, LIST_CELL_DEG)).toEqual(a);
    const north = { latitude: QC.latitude + LIST_CELL_DEG, longitude: QC.longitude };
    expect(cellOf(north, LIST_CELL_DEG)).not.toEqual(a);
    // A cell's side is about 50 m of latitude.
    expect(haversineMeters(QC, north)).toBeGreaterThan(45);
    expect(haversineMeters(QC, north)).toBeLessThan(55);
  });

  it('a cell centre maps to itself', () => {
    const c = cellOf(QC, LIST_CELL_DEG);
    expect(cellOf(c, LIST_CELL_DEG)).toEqual(c);
  });
});
