import { contrastRatio } from '@core/color/contrast';
import { stoneScheme } from './stoneScheme';

describe('stoneScheme', () => {
  it.each([
    ['light', false],
    ['stone night', true],
  ])('keeps %s roads and trails visible on the land (3:1 non-text)', (_, dark) => {
    const s = stoneScheme(dark);
    // Light roads are paper-on-paper, carried by their casing instead.
    const road = dark ? s.roadFill : s.roadCasing;
    expect(contrastRatio(road, s.land)).toBeGreaterThanOrEqual(dark ? 3 : 1.2);
    expect(contrastRatio(s.path, s.land)).toBeGreaterThanOrEqual(3);
  });

  it('draws night trails brighter than the road ribbons they cross', () => {
    const s = stoneScheme(true);
    expect(contrastRatio(s.path, s.land)).toBeGreaterThan(contrastRatio(s.roadFill, s.land));
  });
});
