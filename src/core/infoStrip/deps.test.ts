import { MINUTE_MS, SECOND_MS, stripNeeds } from './deps';
import { DEFAULT_STRIP, presetById, ref } from './presets';

describe('stripNeeds (the coordinator subscribes to exactly this)', () => {
  it('the default strip needs the camera, the DEM and the fix, and no clock', () => {
    const n = stripNeeds(DEFAULT_STRIP.rows);
    expect([...n.deps].sort()).toEqual(['camera', 'elevation', 'position']);
    expect(n.clockMs).toBeNull();
    expect(n.movingSpeed).toBe(false);
    expect(n.deps.has('heading')).toBe(false);
  });

  it('a heading field starts the compass; ETE runs the moving-speed window each second', () => {
    const n = stripNeeds(presetById('navigation')!.strip.rows);
    expect(n.deps.has('heading')).toBe(true);
    expect(n.deps.has('course')).toBe(true);
    expect(n.clockMs).toBe(SECOND_MS);
    expect(n.movingSpeed).toBe(true);
  });

  it('a minute field (or one reading the clock) ticks each minute', () => {
    expect(stripNeeds([[ref('sunset')]]).clockMs).toBe(MINUTE_MS);
    expect(stripNeeds([[ref('declination')]]).clockMs).toBe(MINUTE_MS);
    expect(stripNeeds([[ref('eta')]]).movingSpeed).toBe(true);
  });

  it('unknown fields need nothing; an empty strip needs nothing', () => {
    const n = stripNeeds([[{ field: 'weather:wind', params: {} }], []]);
    expect(n.deps.size).toBe(0);
    expect(n.clockMs).toBeNull();
  });
});
