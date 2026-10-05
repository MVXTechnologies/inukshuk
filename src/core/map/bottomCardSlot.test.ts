import { bottomCardSlotFree } from './bottomCardSlot';

const idle = { railMenuOpen: false, inspecting: false, editingWaypoint: false, drawing: false };

describe('bottomCardSlotFree', () => {
  it('is free on a bare map', () => {
    expect(bottomCardSlotFree(idle)).toBe(true);
  });

  it('steps aside for an open rail sheet (cards used to draw over Overlays)', () => {
    expect(bottomCardSlotFree({ ...idle, railMenuOpen: true })).toBe(false);
  });

  it.each(['inspecting', 'editingWaypoint', 'drawing'] as const)('and while %s', (k) => {
    expect(bottomCardSlotFree({ ...idle, [k]: true })).toBe(false);
  });
});
