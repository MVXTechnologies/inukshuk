/**
 * Toggle an id's membership in a list (add if absent, remove if present).
 * Used for trail-overlay activation and folder-visibility selection.
 * (Lived in bundles.ts until the bundle feature was removed in 1.3.0.)
 */
export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}
