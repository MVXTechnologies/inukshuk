import { DEFAULT_POINTING_LINE } from '@core/map/pointingLineSettings';

import { visibleRows } from './layout';
import { DEFAULT_CURSOR, DEFAULT_STRIP, presetById } from './presets';
import {
  INFO_STRIP_SCHEMA,
  legacyShowCenterCursor,
  MAX_SAVED_STRIPS,
  MAX_STRIP_NAME,
  normaliseCursor,
  normaliseInfoStripSettings,
  normaliseStrip,
} from './settings';

const roundTrip = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

describe('settings.infoStrip', () => {
  it('a missing key means DEFAULT_STRIP', () => {
    for (const raw of [undefined, null, 'junk', 42, []]) {
      expect(normaliseInfoStripSettings(raw)).toEqual({
        schema: INFO_STRIP_SCHEMA,
        current: DEFAULT_STRIP,
        saved: [],
      });
    }
  });

  it("carries 2.5.1's chip-and-dot switch over: off means an empty strip, cursor off", () => {
    const off = normaliseInfoStripSettings(undefined, { showCenterCursor: false });
    expect(off.current.rows).toEqual([]);
    expect(off.current.aids.cursor.enabled).toBe(false);
    expect(normaliseInfoStripSettings(undefined, { showCenterCursor: true }).current).toEqual(
      DEFAULT_STRIP,
    );
    // The default itself is never mutated.
    expect(DEFAULT_STRIP.rows).toHaveLength(1);
    expect(DEFAULT_STRIP.aids.cursor.enabled).toBe(true);
  });

  it('round-trips every preset unchanged', () => {
    const presets = ['default', 'hiking', 'navigation', 'survey', 'paddling'].map(
      (id) => presetById(id)!.strip,
    );
    const raw = roundTrip({ schema: 1, current: presets[2], saved: presets });
    expect(normaliseInfoStripSettings(raw)).toEqual({
      schema: 1,
      current: presets[2],
      saved: presets,
    });
  });

  it('keeps unknown field ids from a newer build, skipped when drawn (rollback safe)', () => {
    const raw = roundTrip({
      schema: 2,
      current: {
        ...DEFAULT_STRIP,
        rows: [
          [
            { field: 'coords', params: { format: 'ddm', newKnob: 1 } },
            { field: 'weather:wind', params: { gusts: true } },
            { field: 'elevation', params: {} },
            { field: 'place:name' },
          ],
        ],
      },
    });
    const s = normaliseInfoStripSettings(raw);
    expect(s.schema).toBe(1);
    expect(s.current.rows[0]!.map((f) => f.field)).toEqual([
      'coords',
      'weather:wind',
      'elevation',
      'place:name',
    ]);
    expect(s.current.rows[0]![1]!.params).toEqual({ gusts: true });
    expect(s.current.rows[0]![3]!.params).toEqual({});
    expect(s.current.rows[0]![0]!.params).toMatchObject({ format: 'ddm', newKnob: 1 });
    // Drawn: the unknown ones are skipped.
    expect(visibleRows(s.current.rows, [], false)[0]!.map((f) => f.field)).toEqual([
      'coords',
      'elevation',
    ]);
    // Written back and read again: nothing lost.
    expect(normaliseInfoStripSettings(roundTrip(s))).toEqual(s);
  });

  it('a 2.6.0 tide field (no station param yet) reads the nearest; a picked one is kept (#695)', () => {
    const s = normaliseStrip({
      rows: [
        [
          { field: 'tides:level', params: {} },
          { field: 'tides:nextHigh', params: { station: '100:03250' } },
          { field: 'tides:level', params: { station: '' } },
        ],
      ],
    })!;
    expect(s.rows[0]!.map((f) => f.params.station)).toEqual(['nearest', '100:03250', 'nearest']);
  });

  it('sanitises a corrupt strip field by field', () => {
    const s = normaliseStrip({
      name: '   ',
      basedOn: '',
      dock: 'left',
      rows: [
        'junk',
        [],
        [null, { field: 7 }, { field: 'speed', params: { style: 'warp' } }],
        [{ field: 'coords' }, { field: 'coords' }, { field: 'speed' }, { field: 'eta' }],
        [{ field: 'eta' }],
        [{ field: 'ete' }],
      ],
      aids: { cursor: { kind: 'star', size: 'XL', color: '#c2185b', halo: 'yes' } },
      target: { kind: 'waypoint' },
    })!;
    expect(s.name).toBe(DEFAULT_STRIP.name);
    expect(s.basedOn).toBeUndefined();
    expect(s.dock).toBe('bottom');
    // Junk rows go; an over-full row keeps what fits; at most 3 rows.
    expect(s.rows.map((r) => r.map((f) => f.field))).toEqual([
      ['speed'],
      ['coords', 'coords'],
      ['eta'],
    ]);
    expect(s.rows[0]![0]!.params).toEqual({ style: 'speed' });
    expect(s.aids.cursor).toEqual({ ...DEFAULT_CURSOR, size: 'XL', color: '#C2185B' });
    expect(s.target).toEqual({ kind: 'navTarget' });
    expect(normaliseStrip('nope')).toBeNull();
    expect(normaliseStrip({})).toMatchObject({ rows: [], dock: 'bottom' });
  });

  it("keeps a strip's name (trimmed, capped), dock, target and pointing line", () => {
    const s = normaliseStrip({
      name: `  ${'R'.repeat(60)}  `,
      basedOn: 'survey',
      dock: 'top',
      rows: [],
      aids: { pointingLine: { enabled: true, length: 9999 } },
      target: { kind: 'coordinate', point: { latitude: 46.8, longitude: -71.2 }, label: '23A' },
    })!;
    expect(s.name).toBe('R'.repeat(MAX_STRIP_NAME));
    expect(s.basedOn).toBe('survey');
    expect(s.dock).toBe('top');
    expect(s.aids.pointingLine).toEqual({ ...DEFAULT_POINTING_LINE, enabled: true });
    expect(s.target).toEqual({
      kind: 'coordinate',
      point: { latitude: 46.8, longitude: -71.2 },
      label: '23A',
    });
  });

  it('saved strips: invalid ones dropped, capped', () => {
    const many = Array.from({ length: MAX_SAVED_STRIPS + 5 }, (_, i) => ({
      ...DEFAULT_STRIP,
      name: `S${i}`,
    }));
    const s = normaliseInfoStripSettings(roundTrip({ current: 'junk', saved: ['x', ...many] }));
    expect(s.saved).toHaveLength(MAX_SAVED_STRIPS);
    expect(s.saved[0]!.name).toBe('S0');
    expect(s.current).toEqual(DEFAULT_STRIP);
    expect(normaliseInfoStripSettings({ current: DEFAULT_STRIP, saved: 'x' }).saved).toEqual([]);
  });

  it('normaliseCursor: junk is the default', () => {
    expect(normaliseCursor(undefined)).toEqual(DEFAULT_CURSOR);
    expect(normaliseCursor({ color: 3, enabled: false, hideWhileFollowing: false })).toEqual({
      ...DEFAULT_CURSOR,
      enabled: false,
      hideWhileFollowing: false,
    });
    expect(normaliseCursor({ color: '#123456' }).color).toBe(DEFAULT_CURSOR.color);
  });
});

describe('legacyShowCenterCursor (rollback safety)', () => {
  it("is on while the strip shows anything, as 2.5.1's switch meant", () => {
    expect(legacyShowCenterCursor(DEFAULT_STRIP)).toBe(true);
    const off = normaliseInfoStripSettings(undefined, { showCenterCursor: false }).current;
    expect(legacyShowCenterCursor(off)).toBe(false);
    expect(legacyShowCenterCursor({ ...off, rows: DEFAULT_STRIP.rows })).toBe(true);
    expect(
      legacyShowCenterCursor({ ...off, aids: { cursor: { ...DEFAULT_CURSOR, enabled: true } } }),
    ).toBe(true);
  });
});
