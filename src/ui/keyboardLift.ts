/** How far a view whose bottom edge is at `bottom` must rise to clear a keyboard whose top is at `top` (null: down). */
export function keyboardLift(bottom: number, top: number | null, margin = 8): number {
  return top === null ? 0 : Math.max(0, bottom + margin - top);
}
