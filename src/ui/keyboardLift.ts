/** How far a view whose bottom edge is at `bottom` must rise to clear a keyboard whose top is at `top`. */
export function keyboardLift(bottom: number, top: number, margin = 8): number {
  return Math.max(0, bottom + margin - top);
}
