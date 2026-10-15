import {
  CURSOR_SUBJECT,
  CURSOR_TICK_MS,
  createRateGate,
  cursorSubject,
  visibleCursor,
} from './cursor';
import { stripNeeds, stripReadsCursor } from './deps';
import { DEFAULT_CURSOR, ref } from './presets';
import { QC } from './testUtils';

const ON = { ...DEFAULT_CURSOR, enabled: true, kind: 'reticle' as const, color: '#D32F2F' };

describe('visibleCursor: a target only while it shows', () => {
  it('the live centre, with the look the map draws it in', () => {
    expect(visibleCursor(ON, QC, false)).toEqual({
      point: QC,
      kind: 'reticle',
      color: '#D32F2F',
      halo: ON.halo,
    });
  });

  it('none when switched off, before the first camera report, or sitting on you', () => {
    expect(visibleCursor({ ...ON, enabled: false }, QC, false)).toBeNull();
    expect(visibleCursor(ON, null, false)).toBeNull();
    // Following you (with a fix): the cursor marks you, nothing to measure.
    expect(visibleCursor(ON, QC, true)).toBeNull();
    expect(visibleCursor({ ...ON, hideWhileFollowing: false }, QC, true)).toBeNull();
  });

  it('a copy: the feed may reuse its centre object', () => {
    const c = { ...QC };
    const v = visibleCursor(ON, c, false);
    c.latitude = 0;
    expect(v?.point.latitude).toBe(QC.latitude);
  });
});

describe('cursorSubject', () => {
  it('"Cursor", spoken "cursor", drawn as the map draws it, one subject for every cursor field', () => {
    const s = cursorSubject({ kind: 'ring', color: '#1E64C8', halo: false });
    expect(s).toEqual({
      key: 'cursor',
      name: 'Cursor',
      glyph: 'filter_center_focus',
      spokenName: 'cursor',
      cursor: { kind: 'ring', color: '#1E64C8', halo: false },
    });
    expect(s.key).toBe(CURSOR_SUBJECT.key);
  });
});

describe('createRateGate: at most one value per period, the last never lost', () => {
  it('passes the first, holds what comes inside the period, flushes the newest', () => {
    const g = createRateGate<number>(CURSOR_TICK_MS);
    expect(g.push(1, 0)).toEqual({ kind: 'emit' });
    expect(g.push(2, 30)).toEqual({ kind: 'wait', inMs: 70 });
    expect(g.push(3, 60)).toEqual({ kind: 'wait', inMs: 40 });
    expect(g.flush(100)).toBe(3);
    expect(g.flush(100)).toBeNull();
    // The flush restarted the period.
    expect(g.push(4, 150)).toEqual({ kind: 'wait', inMs: 50 });
    expect(g.push(5, 200)).toEqual({ kind: 'emit' });
    expect(g.flush(220)).toBeNull();
  });

  it('a 60 Hz pan of one second: values at least a period apart, ending on the last', () => {
    const g = createRateGate<number>(CURSOR_TICK_MS);
    const out: { v: number; t: number }[] = [];
    let flushAt: number | null = null;
    const flush = () => {
      if (flushAt === null) return;
      const v = g.flush(flushAt);
      if (v !== null) out.push({ v, t: flushAt });
      flushAt = null;
    };
    for (let i = 0; i <= 60; i++) {
      const t = Math.round((i * 1000) / 60);
      if (flushAt !== null && t >= flushAt) flush();
      const r = g.push(i, t);
      if (r.kind === 'emit') out.push({ v: i, t });
      else flushAt ??= t + r.inMs;
    }
    flush();
    for (let k = 1; k < out.length; k++) {
      expect(out[k]!.t - out[k - 1]!.t).toBeGreaterThanOrEqual(CURSOR_TICK_MS);
    }
    // 61 reports became 11 or 12 (10 Hz over the 1.1 s they span), the last one kept.
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out[out.length - 1]!.v).toBe(60);
  });
});

describe('the strip reads the live cursor only with a cursor field', () => {
  it('stripReadsCursor and its deps', () => {
    expect(stripReadsCursor([[ref('coords')], [ref('targetDistance')]])).toBe(false);
    expect(stripReadsCursor([[ref('coords')], [ref('speed'), ref('cursorBearing')]])).toBe(true);
    expect(stripReadsCursor([[{ field: 'future:field', params: {} }]])).toBe(false);
    expect([...stripNeeds([[ref('cursorDistance')]]).deps].sort()).toEqual(['cursor', 'position']);
    // No clock for it: it refreshes on camera reports, not on a timer.
    expect(stripNeeds([[ref('cursorDistance')]]).clockMs).toBeNull();
  });
});
