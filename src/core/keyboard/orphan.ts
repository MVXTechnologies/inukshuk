/**
 * The orphaned soft keyboard (QA 2.6.1): on Android, when a focused text
 * field leaves the screen (a dialog's Create, a panel closing), the system
 * hands focus to the first view that can take it — one of the app's
 * always-mounted hidden 1 dp WebViews (PDF rasterizer, photo resizer) — and
 * the keyboard stays up for it, over whatever comes next. No app field is
 * focused then, yet the keyboard shows.
 *
 * While the keyboard shows, the guard checks every {@link ORPHAN_CHECK_MS}
 * whether an app text field holds focus; {@link ORPHAN_CHECKS} misses in a
 * row (so never during a field-to-field hop, which is instant) and it puts
 * the keyboard away. Pure: the caller feeds the checks.
 */
export const ORPHAN_CHECK_MS = 250;
export const ORPHAN_CHECKS = 2;

export function orphanCheck(
  misses: number,
  fieldFocused: boolean,
): { misses: number; dismiss: boolean } {
  if (fieldFocused) return { misses: 0, dismiss: false };
  const next = misses + 1;
  return next >= ORPHAN_CHECKS ? { misses: 0, dismiss: true } : { misses: next, dismiss: false };
}
