import { formatDistance, formatElevation } from '../format';
import { axisGutterWidth, estimateTextWidth } from './axis';

/** The gutter both charts hard-coded before the labels were measured. */
const OLD_FIXED_GUTTER = 40;
const GRAPH_FONT = 9;

describe('estimateTextWidth', () => {
  it('is zero for an empty string and for a non-positive font size', () => {
    expect(estimateTextWidth('', 12)).toBe(0);
    expect(estimateTextWidth('10.00 km', 0)).toBe(0);
    expect(estimateTextWidth('10.00 km', NaN)).toBe(0);
  });

  it('scales linearly with the font size', () => {
    expect(estimateTextWidth('123 m', 18)).toBeCloseTo(estimateTextWidth('123 m', 9) * 2);
  });

  it('grows with each extra digit', () => {
    const one = estimateTextWidth('9.00 km', GRAPH_FONT);
    const two = estimateTextWidth('10.00 km', GRAPH_FONT);
    const three = estimateTextWidth('123.45 km', GRAPH_FONT);
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
  });

  it('knows imperial suffixes are not the same width as metric ones', () => {
    // "mi" is wider than "km" per character-count intuition ('m' is the widest
    // lowercase glyph), which is exactly why counting characters is not enough.
    expect(estimateTextWidth('12.0 mi', GRAPH_FONT)).toBeGreaterThan(
      estimateTextWidth('12.0 ft', GRAPH_FONT),
    );
    expect(estimateTextWidth('m', GRAPH_FONT)).toBeGreaterThan(estimateTextWidth('i', GRAPH_FONT));
  });

  it('charges unknown characters a width rather than ignoring them', () => {
    expect(estimateTextWidth('★★', GRAPH_FONT)).toBeGreaterThan(0);
  });
});

describe('axisGutterWidth', () => {
  const opts = { fontSize: GRAPH_FONT };

  it('leaves room for the label plus the gap, so a right-anchored label starts at x >= 0', () => {
    for (const label of ['9.00 km', '10.00 km', '123.45 km', '1234.56 km', '12.0 mi', '4049 ft']) {
      const gutter = axisGutterWidth([label], opts);
      const x = gutter - 5; // where the component anchors the label
      expect(x - estimateTextWidth(label, GRAPH_FONT)).toBeGreaterThanOrEqual(0);
    }
  });

  it('reproduces the Dashboard defect: the old fixed 40 px gutter clipped two-digit km', () => {
    // 1 digit fitted, which is why the bug only showed up once a weekly total
    // reached 10 km.
    expect(axisGutterWidth([formatDistance(9_000, 'metric')], opts)).toBeLessThanOrEqual(
      OLD_FIXED_GUTTER,
    );
    expect(axisGutterWidth([formatDistance(10_000, 'metric')], opts)).toBeGreaterThan(
      OLD_FIXED_GUTTER,
    );
    expect(axisGutterWidth([formatDistance(123_450, 'metric')], opts)).toBeGreaterThan(
      OLD_FIXED_GUTTER,
    );
    // Imperial clipped too, and at a *lower* number: "123.4 mi" is a shorter
    // string than "123.45 km" but "mi" is wide.
    expect(axisGutterWidth([formatDistance(200_000, 'imperial')], opts)).toBeGreaterThan(
      OLD_FIXED_GUTTER,
    );
  });

  it('sizes from the WIDEST label, not the first or the last', () => {
    const labels = ['1.00 km', '123.45 km', '9.00 km'];
    expect(axisGutterWidth(labels, opts)).toBe(axisGutterWidth(['123.45 km'], opts));
  });

  it('honours the floor for short labels and the ceiling for absurd ones', () => {
    expect(axisGutterWidth(['5 m'], { ...opts, min: 30 })).toBe(30);
    expect(axisGutterWidth(['123456.78 km'], { ...opts, max: 44 })).toBe(44);
    // The ceiling wins over the floor.
    expect(axisGutterWidth(['5 m'], { ...opts, min: 30, max: 12 })).toBe(12);
  });

  it('collapses to nothing when there are no labels to draw', () => {
    expect(axisGutterWidth([], opts)).toBe(0);
    expect(axisGutterWidth([''], opts)).toBe(0);
  });

  it('respects a custom gap', () => {
    expect(axisGutterWidth(['10.00 km'], { ...opts, gap: 12 })).toBe(
      axisGutterWidth(['10.00 km'], { ...opts, gap: 5 }) + 7,
    );
  });

  it('fits the elevation labels the trail profile draws, including big imperial ones', () => {
    const fontSize = 8;
    for (const label of [
      formatElevation(120, 'metric'),
      formatElevation(4_400, 'metric'),
      formatElevation(4_400, 'imperial'), // "14436 ft"
    ]) {
      const gutter = axisGutterWidth([label], { fontSize });
      expect(gutter - 5 - estimateTextWidth(label, fontSize)).toBeGreaterThanOrEqual(0);
    }
  });
});
