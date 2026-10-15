import { parseRegionPayload, regionBox } from './regionPayload';

const VALID = {
  center: [-71.2, 46.8],
  zoom: 14.5,
  bearing: 33,
  pitch: 10,
  bounds: [-71.3, 46.7, -71.1, 46.9],
  animated: true,
  userInteraction: false,
};

describe('parseRegionPayload', () => {
  it('a whole payload: every field, typed', () => {
    expect(parseRegionPayload(VALID)).toEqual({
      center: [-71.2, 46.8],
      zoom: 14.5,
      bearing: 33,
      pitch: 10,
      bounds: [-71.3, 46.7, -71.1, 46.9],
      animated: true,
      userInteraction: false,
    });
  });

  it('a null payload (a pooled RN event read after its handler returned): null, no throw', () => {
    expect(parseRegionPayload(null)).toBeNull();
    expect(parseRegionPayload(undefined)).toBeNull();
    expect(parseRegionPayload('x')).toBeNull();
  });

  it('an empty payload (MapLibre before the camera has a target): null', () => {
    expect(parseRegionPayload({})).toBeNull();
  });

  it('no centre, or a broken one: null', () => {
    const { center: _c, ...noCentre } = VALID;
    expect(parseRegionPayload(noCentre)).toBeNull();
    expect(parseRegionPayload({ ...VALID, center: [NaN, 46] })).toBeNull();
    expect(parseRegionPayload({ ...VALID, center: [-71] })).toBeNull();
    expect(parseRegionPayload({ ...VALID, center: 'here' })).toBeNull();
  });

  it('no zoom, bearing or pitch: null', () => {
    expect(parseRegionPayload({ ...VALID, zoom: undefined })).toBeNull();
    expect(parseRegionPayload({ ...VALID, bearing: null })).toBeNull();
    expect(parseRegionPayload({ ...VALID, pitch: Infinity })).toBeNull();
  });

  it('missing or malformed bounds (the projection threw): kept, with bounds null', () => {
    const { bounds: _b, ...noBounds } = VALID;
    expect(parseRegionPayload(noBounds)?.bounds).toBeNull();
    expect(parseRegionPayload({ ...VALID, bounds: null })?.bounds).toBeNull();
    expect(parseRegionPayload({ ...VALID, bounds: [1, 2, 3] })?.bounds).toBeNull();
    expect(parseRegionPayload({ ...VALID, bounds: [1, 2, 3, 'n'] })?.bounds).toBeNull();
    expect(parseRegionPayload(noBounds)?.center).toEqual([-71.2, 46.8]);
  });

  it('unknown flags read as false', () => {
    const { animated: _a, userInteraction: _u, ...noFlags } = VALID;
    expect(parseRegionPayload(noFlags)).toMatchObject({ animated: false, userInteraction: false });
    expect(parseRegionPayload({ ...VALID, userInteraction: 'yes' })?.userInteraction).toBe(false);
  });
});

describe('regionBox', () => {
  it('names the bounds, or null without them', () => {
    expect(regionBox({ bounds: [1, 2, 3, 4] })).toEqual({ west: 1, south: 2, east: 3, north: 4 });
    expect(regionBox({ bounds: null })).toBeNull();
  });
});
