import { sheetBodyMaxHeight } from './sheetFit';

describe('sheetBodyMaxHeight', () => {
  it('falls back to the window share until both edges are measured', () => {
    expect(
      sheetBodyMaxHeight({ windowHeight: 800, maxShare: 0.6, areaBottom: null, bodyTop: 200 }),
    ).toBe(480);
    expect(
      sheetBodyMaxHeight({ windowHeight: 800, maxShare: 0.6, areaBottom: 700, bodyTop: null }),
    ).toBe(480);
  });

  it('stops above the tab bar when the window share would run past the map area', () => {
    // Phone: window 800, map area ends at 720 (tab bar below), body starts at 300.
    // 60 % of the window (480) would end at 780 — behind the tab bar.
    expect(
      sheetBodyMaxHeight({ windowHeight: 800, maxShare: 0.6, areaBottom: 720, bodyTop: 300 }),
    ).toBe(408);
  });

  it('keeps the window share when there is room for it', () => {
    expect(
      sheetBodyMaxHeight({ windowHeight: 1000, maxShare: 0.4, areaBottom: 950, bodyTop: 150 }),
    ).toBe(400);
  });

  it('never collapses below the floor', () => {
    expect(
      sheetBodyMaxHeight({ windowHeight: 400, maxShare: 0.6, areaBottom: 300, bodyTop: 260 }),
    ).toBe(120);
  });
});
