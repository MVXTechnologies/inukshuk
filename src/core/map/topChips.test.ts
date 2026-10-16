import { CHIP_ROW, SEARCH_SLOT_OFFSET, chipRow, searchSlotOffset, topChipLayout } from './topChips';

describe('topChipLayout', () => {
  it('under the search pill: lane, then On map, then the receiver', () => {
    expect(topChipLayout({ teamBarHeight: 0, laneTaken: false, onMapChip: false })).toEqual({
      lane: SEARCH_SLOT_OFFSET,
      onMap: SEARCH_SLOT_OFFSET,
      receiver: SEARCH_SLOT_OFFSET,
    });
    expect(topChipLayout({ teamBarHeight: 0, laneTaken: true, onMapChip: true })).toEqual({
      lane: SEARCH_SLOT_OFFSET,
      onMap: SEARCH_SLOT_OFFSET + CHIP_ROW,
      receiver: SEARCH_SLOT_OFFSET + 2 * CHIP_ROW,
    });
  });

  it('team mode: every row sits below the team bar and its chip row (#707, #710)', () => {
    // The bar publishes pill + gap + its chip row: 48 + 8 + 36.
    const bar = 92;
    const l = topChipLayout({ teamBarHeight: bar, laneTaken: false, onMapChip: true });
    expect(l.lane).toBe(8 + bar + 8);
    expect(l.onMap).toBe(8 + bar + 8);
    expect(l.onMap).toBeGreaterThan(8 + bar);
    expect(l.receiver).toBe(8 + bar + 8 + CHIP_ROW);
    const taken = topChipLayout({ teamBarHeight: bar, laneTaken: true, onMapChip: true });
    expect(taken.onMap).toBe(8 + bar + 8 + CHIP_ROW);
    expect(taken.receiver).toBe(8 + bar + 8 + 2 * CHIP_ROW);
  });
});

describe('at a Display size (#760)', () => {
  it('is the 100 % layout at 1', () => {
    expect(searchSlotOffset(1)).toBe(SEARCH_SLOT_OFFSET);
    expect(chipRow(1)).toBe(CHIP_ROW);
  });

  it('rows pack tighter at Small and open up at Large', () => {
    expect(searchSlotOffset(0.85)).toBe(6.5 + 41 + 6.5);
    expect(chipRow(0.85)).toBe(30.5 + 6.5);
    expect(searchSlotOffset(1.15)).toBe(10 + 55 + 10);
    const small = topChipLayout({
      factor: 0.85,
      teamBarHeight: 0,
      laneTaken: true,
      onMapChip: true,
    });
    expect(small.receiver).toBe(searchSlotOffset(0.85) + 2 * chipRow(0.85));
    expect(small.receiver).toBeLessThan(SEARCH_SLOT_OFFSET + 2 * CHIP_ROW);
  });

  it('under the team bar, the gaps scale as spacing', () => {
    expect(
      topChipLayout({ factor: 0.85, teamBarHeight: 80, laneTaken: false, onMapChip: false }).lane,
    ).toBe(6.5 + 80 + 6.5);
  });
});
