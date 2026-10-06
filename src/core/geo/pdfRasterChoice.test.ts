import { chooseRasters } from './pdfRasterChoice';

const r = (key: string, pixels: number) => ({ key, pixels });

describe('chooseRasters', () => {
  it('shows every cell with the fewest pixels when everything fits', () => {
    const big = r('big', 6);
    const a = r('a', 2);
    const b = r('b', 2);
    const holders = [
      [big, a],
      [big, a],
      [big, b],
      [big, b],
    ];
    const choice = chooseRasters(holders, [b, a, big], 10);
    expect(choice.covered.size).toBe(4);
    expect(choice.pixels).toBe(4);
  });

  it('prefers the new blocks over an old block mostly off screen when the budget is tight', () => {
    // The old block holds three visible cells and much off-screen area; the
    // two new blocks were rendered for the view and fit the budget together.
    const old = r('old', 5);
    const n1 = r('n1', 3);
    const n2 = r('n2', 3);
    const holders = [[old, n1], [old, n1], [old, n1], [n2], [n2], [n2]];
    const choice = chooseRasters(holders, [n2, n1, old], 6);
    expect(choice.covered.size).toBe(6);
    expect(choice.chosen.map((c) => c.key).sort()).toEqual(['n1', 'n2']);
  });

  it('falls back to recency when efficiency strands a cell', () => {
    // Efficiency takes `wide` (4 cells / 4 px), then nothing else fits; the
    // newest pair shows all five.
    const wide = r('wide', 4);
    const x = r('x', 3);
    const y = r('y', 3);
    const holders = [[wide, x], [wide, x], [wide, y], [wide, y], [y]];
    const choice = chooseRasters(holders, [x, y, wide], 6);
    expect(choice.covered.size).toBe(5);
  });

  it('never exceeds the budget, and ignores cells nothing holds', () => {
    const a = r('a', 5);
    const choice = chooseRasters([[a], []], [a], 4);
    expect(choice.chosen).toEqual([]);
    expect(choice.pixels).toBe(0);
  });
});
