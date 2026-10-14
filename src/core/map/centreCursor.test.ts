import { centreCursorPoint } from './centreCursor';

const CENTRE = { latitude: 46.8139, longitude: -71.2082 };
const YOU = { latitude: 46.812, longitude: -71.209 };

describe('centreCursorPoint (#709)', () => {
  it('is the map centre', () => {
    expect(centreCursorPoint(CENTRE, false, YOU)).toEqual(CENTRE);
    expect(centreCursorPoint(CENTRE, false, null)).toEqual(CENTRE);
  });

  it('is you while the map follows you with a fix', () => {
    expect(centreCursorPoint(CENTRE, true, YOU)).toEqual(YOU);
    // Following but no fix yet: the centre.
    expect(centreCursorPoint(CENTRE, true, null)).toEqual(CENTRE);
  });

  it('is nothing before a real camera (no 0, 0 point)', () => {
    expect(centreCursorPoint(null, false, YOU)).toBeNull();
    expect(centreCursorPoint({ latitude: 0, longitude: 0 }, false, null)).toBeNull();
  });

  it('copies the point (no shared identity with the store)', () => {
    const p = centreCursorPoint(CENTRE, false, null);
    expect(p).not.toBe(CENTRE);
  });
});
