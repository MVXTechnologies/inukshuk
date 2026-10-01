import { bottomRowLayout, type BottomRowWidths } from './panelLayout';

// Undo + Clear (52 + 8 + 52), the "Back & forth" chip, "Save route".
const base: Omit<BottomRowWidths, 'row'> = {
  icons: 112,
  chipFull: 143,
  chipCompact: 66,
  save: 118,
  gap: 8,
};

describe('bottomRowLayout', () => {
  it('fits everything on one row when it can', () => {
    expect(bottomRowLayout({ ...base, row: 430 - 36 })).toEqual({ mode: 'full', chipLabel: true });
  });

  it('collapses the Return chip first (Save keeps its width)', () => {
    // 375 pt screen: 339 of row; 112+8+143+8+118 = 389 > 339, compact 309 fits.
    expect(bottomRowLayout({ ...base, row: 375 - 36 })).toEqual({
      mode: 'compact',
      chipLabel: false,
    });
  });

  it('moves Save to its own row when even the compact chip does not leave room', () => {
    // 320 pt screen: 284 of row; compact needs 309.
    expect(bottomRowLayout({ ...base, row: 320 - 36 })).toEqual({
      mode: 'stacked',
      chipLabel: true, // 112 + 8 + 143 = 263 fits the icon row alone
    });
    expect(bottomRowLayout({ ...base, chipFull: 200, row: 284 })).toEqual({
      mode: 'stacked',
      chipLabel: false,
    });
  });

  it('without a chip (area panel): full unless Save cannot fit', () => {
    const area = { ...base, chipFull: 0, chipCompact: 0 };
    expect(bottomRowLayout({ ...area, row: 284 })).toEqual({ mode: 'full', chipLabel: true });
    expect(bottomRowLayout({ ...area, save: 200, row: 284 }).mode).toBe('stacked');
  });

  it('before measuring: full', () => {
    expect(bottomRowLayout({ ...base, row: 0 }).mode).toBe('full');
  });
});
