/**
 * The map's shared sprite set (2.5.2 QA: pin icons gone after drawing mode).
 *
 * MapLibre's `<Images>` is not reference-counted. Unmounting one, or the
 * native side detaching it, removes EVERY name it holds from the style, even
 * a name another layer registered and still draws; on Android a detached
 * instance also forgets its own list, so nothing re-adds them. And once the
 * renderer has asked for an icon and been answered, it does not ask again
 * until the style reloads (a theme change). So a sprite that more than one
 * layer uses, or that a layer which mounts and unmounts registers, can vanish
 * for good.
 *
 * The rule this module keeps: the shared sprites (waypoint pins and glyphs,
 * the count pills the pin clusters and photo stacks share, the drawing
 * arrowheads and badges) are registered by ONE `<Images>` per map that never
 * unmounts, and its list only grows. Layers ask for names; they never own them.
 *
 * Pure: names in, names out. The sprite sources are the feature layer's.
 */

export interface MapImageSet {
  /** Every name registered so far, in registration order. Never shrinks. */
  readonly names: readonly string[];
  /**
   * Bumped when the native side has lost names it was given (it reports a
   * registered name missing): the one `<Images>` re-mounts under a new key
   * and registers the whole set again.
   */
  readonly generation: number;
  /** Re-registrations so far (capped: a sprite that cannot load must not loop). */
  readonly heals: number;
}

/** At most this many re-registrations per session (each one re-sends the set). */
export const MAX_IMAGE_HEALS = 5;

export function mapImageSet(initial: Iterable<string>): MapImageSet {
  return { names: [...new Set(initial)], generation: 0, heals: 0 };
}

/**
 * The set with `wanted` added: the SAME object when nothing is new (so a
 * subscriber re-renders only on a real addition). Unknown names are skipped.
 */
export function withImages(
  set: MapImageSet,
  wanted: Iterable<string>,
  known: (name: string) => boolean,
): MapImageSet {
  const have = new Set(set.names);
  const added: string[] = [];
  for (const name of wanted) {
    if (have.has(name) || !known(name)) continue;
    have.add(name);
    added.push(name);
  }
  return added.length === 0 ? set : { ...set, names: [...set.names, ...added] };
}

/**
 * The map reported `name` missing. Unknown: someone else's (a photo sprite,
 * an extension's symbol). Known but not registered yet: register it (a
 * cluster of 40 asks for its pill when it first draws). Registered already:
 * the native side lost it, so re-register the whole set (capped).
 */
export function onImageMissing(
  set: MapImageSet,
  name: string,
  known: (name: string) => boolean,
): MapImageSet {
  if (!known(name)) return set;
  if (!set.names.includes(name)) return withImages(set, [name], known);
  if (set.heals >= MAX_IMAGE_HEALS) return set;
  return { ...set, generation: set.generation + 1, heals: set.heals + 1 };
}
