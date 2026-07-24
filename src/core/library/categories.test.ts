import { contrastRatio } from '@core/color/contrast';
import {
  allCategories,
  BUILT_IN_CATEGORIES,
  CATEGORY_COLOR_PALETTE,
  categoryColor,
  CUSTOM_CATEGORY_ICON,
  DEFAULT_CATEGORY_ID,
  findCategory,
  MAX_CATEGORY_NAME_LENGTH,
  validateCategoryName,
  type CustomCategory,
} from './categories';

const CUSTOM: CustomCategory[] = [
  { id: 'c1', name: 'Packrafting', color: '#C74FA0', createdAt: 1 },
  { id: 'c2', name: 'Via Ferrata', color: '#6C7A93', createdAt: 2 },
];

describe('built-in categories', () => {
  it('includes the expected activities with unique ids, icons and colors', () => {
    const names = BUILT_IN_CATEGORIES.map((c) => c.name);
    expect(names).toEqual([
      'Hike',
      'Run',
      'Trail Run',
      'Bike',
      'Ski',
      'Snowshoe',
      'Walk',
      'Navigation trail',
      'Other',
    ]);
    expect(new Set(BUILT_IN_CATEGORIES.map((c) => c.id)).size).toBe(BUILT_IN_CATEGORIES.length);
    expect(new Set(BUILT_IN_CATEGORIES.map((c) => c.color)).size).toBe(BUILT_IN_CATEGORIES.length);
    for (const c of BUILT_IN_CATEGORIES) {
      expect(c.builtIn).toBe(true);
      expect(c.icon.length).toBeGreaterThan(0);
    }
  });

  it('the default category id resolves to a built-in', () => {
    expect(findCategory(DEFAULT_CATEGORY_ID, [])?.builtIn).toBe(true);
  });

  it('every built-in and palette color is theme-safe (≥3:1 on both surfaces)', () => {
    // Card surfaces from src/ui/theme.ts (lightTheme.surface / darkTheme.surface).
    // If the theme's surfaces change, re-verify these mirrors.
    const LIGHT_SURFACE = '#FBF8F2';
    const DARK_SURFACE = '#1B1E17';
    const colors = [...BUILT_IN_CATEGORIES.map((c) => c.color), ...CATEGORY_COLOR_PALETTE];
    for (const color of colors) {
      expect(contrastRatio(color, LIGHT_SURFACE)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(color, DARK_SURFACE)).toBeGreaterThanOrEqual(3);
    }
  });

  it('palette includes every built-in color plus extras, all unique', () => {
    for (const c of BUILT_IN_CATEGORIES) expect(CATEGORY_COLOR_PALETTE).toContain(c.color);
    expect(new Set(CATEGORY_COLOR_PALETTE).size).toBe(CATEGORY_COLOR_PALETTE.length);
  });
});

describe('allCategories', () => {
  it('lists built-ins first, then customs in order, with the custom icon', () => {
    const all = allCategories(CUSTOM);
    expect(all).toHaveLength(BUILT_IN_CATEGORIES.length + 2);
    expect(all.slice(0, BUILT_IN_CATEGORIES.length)).toEqual(BUILT_IN_CATEGORIES);
    expect(all[BUILT_IN_CATEGORIES.length]).toEqual({
      id: 'c1',
      name: 'Packrafting',
      icon: CUSTOM_CATEGORY_ICON,
      color: '#C74FA0',
      builtIn: false,
    });
  });

  it('returns only built-ins when there are no customs', () => {
    expect(allCategories([])).toEqual([...BUILT_IN_CATEGORIES]);
  });
});

describe('findCategory / categoryColor', () => {
  it('resolves built-in ids', () => {
    expect(findCategory('bike', CUSTOM)?.name).toBe('Bike');
    expect(categoryColor('bike', CUSTOM)).toBe('#3E7BA0');
  });

  it('resolves custom ids', () => {
    const c = findCategory('c2', CUSTOM);
    expect(c?.name).toBe('Via Ferrata');
    expect(c?.builtIn).toBe(false);
    expect(c?.icon).toBe(CUSTOM_CATEGORY_ICON);
  });

  it('returns null (neutral fallback) for absent, empty, unknown and junk ids', () => {
    expect(findCategory(undefined, CUSTOM)).toBeNull();
    expect(findCategory(null, CUSTOM)).toBeNull();
    expect(findCategory('', CUSTOM)).toBeNull();
    expect(findCategory('deleted-custom', CUSTOM)).toBeNull();
    // A hand-edited index could hold a non-string; the lookup must not throw.
    expect(findCategory(42 as unknown as string, CUSTOM)).toBeNull();
    expect(categoryColor('nope', CUSTOM)).toBeNull();
  });
});

describe('validateCategoryName', () => {
  it('accepts a fresh name and returns it trimmed', () => {
    expect(validateCategoryName('  Canoe  ', CUSTOM)).toEqual({ ok: true, name: 'Canoe' });
  });

  it('rejects empty and whitespace-only names', () => {
    expect(validateCategoryName('', CUSTOM)).toEqual({ ok: false, reason: 'empty' });
    expect(validateCategoryName('   ', CUSTOM)).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects names longer than the cap (after trimming)', () => {
    const long = 'x'.repeat(MAX_CATEGORY_NAME_LENGTH + 1);
    expect(validateCategoryName(long, CUSTOM)).toEqual({ ok: false, reason: 'too-long' });
    const exact = 'x'.repeat(MAX_CATEGORY_NAME_LENGTH);
    expect(validateCategoryName(` ${exact} `, CUSTOM)).toEqual({ ok: true, name: exact });
  });

  it('rejects case-insensitive duplicates of built-ins and customs', () => {
    expect(validateCategoryName('hike', CUSTOM)).toEqual({ ok: false, reason: 'duplicate' });
    expect(validateCategoryName('TRAIL RUN', CUSTOM)).toEqual({ ok: false, reason: 'duplicate' });
    expect(validateCategoryName('packrafting', CUSTOM)).toEqual({
      ok: false,
      reason: 'duplicate',
    });
  });
});
