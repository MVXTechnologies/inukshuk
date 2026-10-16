import { fitsOneLine, osTextScale, rowRoomDp, textAdvanceDp } from './textFit';

describe('osTextScale', () => {
  it('applies the cap, and reads junk as 1', () => {
    expect(osTextScale(1.3)).toBe(1.3);
    expect(osTextScale(1.3, 1.15)).toBe(1.15);
    expect(osTextScale(0.9, 1.15)).toBe(0.9);
    expect(osTextScale(NaN)).toBe(1);
    expect(osTextScale(0)).toBe(1);
  });
});

describe('textAdvanceDp', () => {
  it('is em × size at 100 %', () => {
    expect(textAdvanceDp(3.29, 14, 1)).toBeCloseTo(46.06, 2);
  });

  it('follows the Display size and the text floor', () => {
    // 14 sp at Small is 12; 12 sp at Small is held at the 10 sp floor.
    expect(textAdvanceDp(2, 14, 0.85)).toBe(24);
    expect(textAdvanceDp(2, 12, 0.85)).toBe(20);
    expect(textAdvanceDp(2, 14, 1.15, 1.3, 1.15)).toBeCloseTo(2 * 16 * 1.15, 6);
  });
});

describe('rowRoomDp', () => {
  // A Settings row: 16 + 24 padding, a 24 dp chevron and a 16 dp gap.
  const row = { spacing: [16, 24, 16], boxes: [24] };

  it('is the screen less spacing and boxes at 100 %', () => {
    expect(rowRoomDp(360, row, 1)).toBe(280);
  });

  it('gives text more room at Small than the size alone would', () => {
    const small = rowRoomDp(360, row, 0.85);
    // Spacing shrinks to 0.784, boxes to 0.85.
    expect(small).toBe(360 - 12.5 - 19 - 12.5 - 20.5);
    expect(small).toBeGreaterThan(rowRoomDp(360, row, 1));
  });

  it('gives less at Large', () => {
    expect(rowRoomDp(360, row, 1.15)).toBeLessThan(280);
  });
});

describe('fitsOneLine', () => {
  const row = { spacing: [16, 24, 16], boxes: [52] };
  // A description that exactly fills the row at 100 %.
  const em = rowRoomDp(360, row, 1) / 14;

  it('a text that just fits at Default fits at Small (denser spacing)', () => {
    expect(fitsOneLine(em, 14, rowRoomDp(360, row, 1), 1)).toBe(true);
    expect(fitsOneLine(em, 14, rowRoomDp(360, row, 0.85), 0.85)).toBe(true);
  });

  it('and wraps at Large, where it truly does not fit', () => {
    expect(fitsOneLine(em, 14, rowRoomDp(360, row, 1.15), 1.15)).toBe(false);
  });

  it('a bigger OS font can push it over, a cap brings it back', () => {
    const room = rowRoomDp(360, row, 1);
    expect(fitsOneLine(em, 14, room, 1, 1.3)).toBe(false);
    expect(fitsOneLine(em, 14, room, 1, 1.3, 1)).toBe(true);
  });
});
