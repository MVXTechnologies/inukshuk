/**
 * Activity categories for recorded trails (Hike, Run, Bike, …), plus
 * user-defined custom categories. Pure domain logic — the Zustand store and UI
 * are thin wrappers over these helpers.
 *
 * Colors are "theme-safe": every built-in and palette color keeps a WCAG
 * contrast ratio of at least 3:1 against BOTH themes' card surfaces, so a
 * category chip/border/icon stays legible in light and dark mode alike
 * (gated by categories.test.ts via `@core/color/contrast`).
 */

/** A resolved category: either a built-in or a user-defined custom one. */
export interface CategoryDefinition {
  /** Built-in slug (`'hike'`) or the custom category's generated id. */
  id: string;
  name: string;
  /** MaterialCommunityIcons glyph name. */
  icon: string;
  /** `#RRGGBB` hex, legible on light and dark surfaces. */
  color: string;
  builtIn: boolean;
}

/** A user-defined category, as persisted in the library index. */
export interface CustomCategory {
  id: string;
  name: string;
  /** `#RRGGBB` hex picked from {@link CATEGORY_COLOR_PALETTE}. */
  color: string;
  createdAt: number;
}

/** Icon used for every custom category (built-ins each have their own). */
export const CUSTOM_CATEGORY_ICON = 'tag';

/** Default selection for the record-start picker before any is remembered. */
export const DEFAULT_CATEGORY_ID = 'hike';

/** Longest accepted custom category name (after trimming). */
export const MAX_CATEGORY_NAME_LENGTH = 24;

export const BUILT_IN_CATEGORIES: readonly CategoryDefinition[] = [
  { id: 'hike', name: 'Hike', icon: 'hiking', color: '#3E8E5A', builtIn: true },
  { id: 'run', name: 'Run', icon: 'run', color: '#D8455F', builtIn: true },
  { id: 'trail-run', name: 'Trail Run', icon: 'run-fast', color: '#C96A1F', builtIn: true },
  { id: 'bike', name: 'Bike', icon: 'bike', color: '#3E7BA0', builtIn: true },
  { id: 'ski', name: 'Ski', icon: 'ski', color: '#2E8FA8', builtIn: true },
  { id: 'snowshoe', name: 'Snowshoe', icon: 'snowshoeing', color: '#8A63C9', builtIn: true },
  { id: 'walk', name: 'Walk', icon: 'walk', color: '#2E9B8F', builtIn: true },
  // Untimed imported GPX (a planned route, someone else's trace) — so a
  // timeless file never masquerades as a recorded run.
  {
    id: 'navigation',
    name: 'Navigation trail',
    icon: 'map-marker-path',
    color: '#5C7A99',
    builtIn: true,
  },
  { id: 'other', name: 'Other', icon: 'compass-outline', color: '#8A8B8C', builtIn: true },
];

/**
 * Swatches offered when creating a custom category. Starts with the built-in
 * colors (hue families users already associate with activities) plus four
 * extras; all theme-safe (see module doc).
 */
export const CATEGORY_COLOR_PALETTE: readonly string[] = [
  ...BUILT_IN_CATEGORIES.map((c) => c.color),
  '#C74FA0', // pink
  '#7E8A2E', // olive
  '#A2703F', // brown
  '#6C7A93', // slate
];

/** Normalize a persisted custom category into a resolved definition. */
function fromCustom(c: CustomCategory): CategoryDefinition {
  return { id: c.id, name: c.name, icon: CUSTOM_CATEGORY_ICON, color: c.color, builtIn: false };
}

/** All selectable categories: built-ins first, then customs in creation order. */
export function allCategories(custom: readonly CustomCategory[]): CategoryDefinition[] {
  return [...BUILT_IN_CATEGORIES, ...custom.map(fromCustom)];
}

/**
 * Resolve a track's `category` id. Returns null for uncategorized tracks
 * (absent id — e.g. saved before this feature existed, or imported GPX) and
 * for dangling/unknown ids, so callers fall back to a neutral rendering.
 */
export function findCategory(
  id: string | null | undefined,
  custom: readonly CustomCategory[],
): CategoryDefinition | null {
  if (typeof id !== 'string' || id === '') return null;
  return (
    BUILT_IN_CATEGORIES.find((c) => c.id === id) ??
    custom.filter((c) => c.id === id).map(fromCustom)[0] ??
    null
  );
}

/** The category's color, or null when uncategorized/unknown (use a neutral). */
export function categoryColor(
  id: string | null | undefined,
  custom: readonly CustomCategory[],
): string | null {
  return findCategory(id, custom)?.color ?? null;
}

export type CategoryNameValidation =
  | { ok: true; name: string }
  | { ok: false; reason: 'empty' | 'too-long' | 'duplicate' };

/**
 * Validate a new custom category's name: trimmed, non-empty, bounded, and not
 * a (case-insensitive) duplicate of a built-in or existing custom name.
 */
export function validateCategoryName(
  raw: string,
  existing: readonly CustomCategory[],
): CategoryNameValidation {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, reason: 'empty' };
  if (name.length > MAX_CATEGORY_NAME_LENGTH) return { ok: false, reason: 'too-long' };
  const lower = name.toLowerCase();
  const taken = allCategories(existing).some((c) => c.name.trim().toLowerCase() === lower);
  if (taken) return { ok: false, reason: 'duplicate' };
  return { ok: true, name };
}
