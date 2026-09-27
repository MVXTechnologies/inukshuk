import { target } from './tokens';

/**
 * The `hitSlop` that grows a `visual`-dp square control to the 48 dp minimum
 * touch target (revamp §8: gloves). 0 once the visual is already big enough.
 */
export function hitSlopFor(visual: number, min: number = target.min): number {
  return Math.max(0, Math.ceil((min - visual) / 2));
}
