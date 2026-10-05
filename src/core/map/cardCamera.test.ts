import { cardCameraCenterPx, freeAreaCenter } from './cardCamera';

const SIZE = { width: 400, height: 800 };

describe('cardCameraCenterPx', () => {
  it('slides the map so the feature lands mid-way between the top chrome and the card', () => {
    // Free area 100..500 → its centre is (200, 300). The feature sits at the
    // screen centre (200, 400), hidden under a card whose top is at 500.
    const c = cardCameraCenterPx({
      featurePx: [200, 400],
      mapSize: SIZE,
      visibleTop: 100,
      visibleBottom: 500,
    });
    // Content must move up 100 px → the camera centre moves down 100 px.
    expect(c).toEqual([200, 500]);
  });

  it('moves sideways too (a mark tapped near an edge)', () => {
    expect(
      cardCameraCenterPx({
        featurePx: [40, 300],
        mapSize: SIZE,
        visibleTop: 100,
        visibleBottom: 500,
      }),
    ).toEqual([40, 400]); // content moves right 160 px → camera centre moves left
  });

  it('leaves an already centred feature alone (no jitter)', () => {
    expect(
      cardCameraCenterPx({
        featurePx: [205, 296],
        mapSize: SIZE,
        visibleTop: 100,
        visibleBottom: 500,
      }),
    ).toBeNull();
  });

  it('gives up when the card leaves no room, or the input is junk', () => {
    expect(
      cardCameraCenterPx({
        featurePx: [200, 400],
        mapSize: SIZE,
        visibleTop: 100,
        visibleBottom: 130,
      }),
    ).toBeNull();
    expect(
      cardCameraCenterPx({
        featurePx: [Number.NaN, 400],
        mapSize: SIZE,
        visibleTop: 100,
        visibleBottom: 500,
      }),
    ).toBeNull();
  });

  it('clamps the free area to the map', () => {
    expect(
      freeAreaCenter({ featurePx: [0, 0], mapSize: SIZE, visibleTop: -50, visibleBottom: 2000 }),
    ).toEqual([200, 400]);
  });
});
