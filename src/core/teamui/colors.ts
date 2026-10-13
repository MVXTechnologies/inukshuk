/**
 * Member colours (#589 UI): one per member, the same on every phone, kept for
 * the life of the team. The index is the member's position in join order
 * (the fold order of the op that introduced them, removed members included),
 * so a removal never shifts anyone else's colour.
 *
 * Eight hues that read on the light and the dark basemaps and stay clear of
 * the route orange-red and the location-puck blue. Distinct enough by hue
 * for the first eight; past that they repeat (names and initials still tell
 * people apart).
 */
export const MEMBER_COLORS = [
  '#E07B39', // ember
  '#3F8FD8', // lake
  '#9B6ADE', // heather
  '#1FA58C', // spruce
  '#D9A520', // larch
  '#D9577F', // fireweed
  '#6E9F32', // moss
  '#7C8C99', // granite
] as const;

export function memberColor(index: number): string {
  const n = MEMBER_COLORS.length;
  return MEMBER_COLORS[((index % n) + n) % n] ?? MEMBER_COLORS[0];
}

/** One or two capital initials for an avatar ("Julie Tremblay" → "JT"). */
export function initials(name: string): string {
  // Words that start with a letter or digit once punctuation is trimmed
  // ("Alex (Guide)" → "AG", not "A(").
  const words = name
    .split(/[\s·._-]+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter((w) => w.length > 0);
  const first = [...(words[0] ?? '?')][0] ?? '?';
  const second = words.length > 1 ? ([...(words[words.length - 1] ?? '')][0] ?? '') : '';
  return (first + second).toLocaleUpperCase();
}
