import { hitSlopFor } from './hitTarget';
import { target } from './tokens';

describe('hitSlopFor', () => {
  it('grows the 36 dp compact visual to 48 with 6 dp each side', () => {
    expect(hitSlopFor(target.compact)).toBe(target.compactHitSlop);
  });

  it('adds nothing to a control that is already 48 dp or larger', () => {
    expect(hitSlopFor(48)).toBe(0);
    expect(hitSlopFor(64)).toBe(0);
  });

  it('rounds up so an odd shortfall never leaves the target under 48', () => {
    expect(36 + 2 * hitSlopFor(35)).toBeGreaterThanOrEqual(48 - 1);
    expect(35 + 2 * hitSlopFor(35)).toBeGreaterThanOrEqual(48);
  });

  it('honours a custom minimum', () => {
    expect(hitSlopFor(20, 32)).toBe(6);
  });
});
