import { createRowBudget, LIBRARY_ROW_PAGE, nearScrollEnd } from './rowBudget';

describe('createRowBudget', () => {
  it('takes rows in display order across lists until the budget is spent', () => {
    const budget = createRowBudget(5);
    expect(budget.take([1, 2, 3])).toEqual([1, 2, 3]);
    expect(budget.take(['a', 'b', 'c', 'd'])).toEqual(['a', 'b']);
    expect(budget.take([9, 9])).toEqual([]);
    expect(budget.hidden).toBe(4);
  });

  it('hides nothing when everything fits', () => {
    const budget = createRowBudget(LIBRARY_ROW_PAGE);
    expect(budget.take(Array.from({ length: LIBRARY_ROW_PAGE }, (_, i) => i))).toHaveLength(
      LIBRARY_ROW_PAGE,
    );
    expect(budget.hidden).toBe(0);
  });

  it('treats a negative or fractional limit as its floor, never below zero', () => {
    expect(createRowBudget(-3).take([1])).toEqual([]);
    expect(createRowBudget(1.9).take([1, 2])).toEqual([1]);
  });

  it('bounds the mounted rows of a 400-trail library to one page', () => {
    const budget = createRowBudget(LIBRARY_ROW_PAGE);
    const rows = budget.take(Array.from({ length: 400 }, (_, i) => i));
    expect(rows).toHaveLength(LIBRARY_ROW_PAGE);
    expect(budget.hidden).toBe(400 - LIBRARY_ROW_PAGE);
  });
});

describe('nearScrollEnd', () => {
  it('is true within the threshold of the end, false before it', () => {
    expect(nearScrollEnd(0, 800, 5000, 1200)).toBe(false);
    expect(nearScrollEnd(3000, 800, 5000, 1200)).toBe(true);
    expect(nearScrollEnd(0, 800, 700)).toBe(true);
  });
});
