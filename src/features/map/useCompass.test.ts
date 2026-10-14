/**
 * The shared compass stream says which north it is on (#673 review): the OS
 * reports trueHeading −1 until it has a fix to compute the declination from,
 * and the magnetic heading it falls back to must be labelled magnetic.
 */
import type * as Location from 'expo-location';

import { onHeading, subscribeHeading, type CompassSample } from './useCompass';

jest.mock('expo-location', () => ({
  watchHeadingAsync: jest.fn(() => new Promise(() => undefined)),
}));

const event = (trueHeading: number, magHeading: number): Location.LocationHeadingObject => ({
  trueHeading,
  magHeading,
  accuracy: 3,
});

describe('compass reference', () => {
  let got: CompassSample[];
  let unsubscribe: () => void;
  beforeEach(() => {
    got = [];
    unsubscribe = subscribeHeading((s) => got.push(s));
  });
  afterEach(() => unsubscribe());

  it('no fix yet (trueHeading −1): the magnetic heading, labelled magnetic', () => {
    onHeading(event(-1, 100));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ reference: 'magnetic' });
    expect(got[0]!.headingDeg).toBeCloseTo(100, 0);
  });

  it('with a fix: the true heading, labelled true', () => {
    onHeading(event(114.6, 100));
    expect(got[0]).toMatchObject({ reference: 'true' });
    expect(got[0]!.headingDeg).toBeCloseTo(114.6, 0);
  });

  it('switching north restarts the filter: no smoothing across the declination', () => {
    onHeading(event(-1, 100));
    onHeading(event(130, 100));
    const last = got[got.length - 1]!;
    expect(last.reference).toBe('true');
    // A filter carried over would still be easing from 100° towards 130°.
    expect(last.headingDeg).toBeCloseTo(130, 0);
  });
});
