import { restGap } from './keyboardLift';

describe('restGap', () => {
  it('is the distance to the window bottom less a margin', () => {
    expect(restGap(800, 900)).toBe(92);
    expect(restGap(800, 900, 0)).toBe(100);
  });

  it('is never negative (a view already at the bottom edge rises by the whole keyboard)', () => {
    expect(restGap(900, 900)).toBe(0);
  });
});
