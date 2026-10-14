import { CHIP_ROW, SEARCH_SLOT_OFFSET, topChipLayout } from './topChips';

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
