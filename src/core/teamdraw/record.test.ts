import { isLive, visibleFields } from '@core/team/crdt';
import { entityKey } from '@core/team/data';
import { authorizeRecord, emptyIndex } from '@core/team/records';
import { T0, MIN, HOUR } from '@core/team/testing/fixtures';
import { MEMBER_COLORS } from '@core/teamui/colors';
import { encodePolyline } from '@core/trails/polyline';

import { destination, type Pt } from './geo';
import {
  COLOUR_COUNT,
  drawWrite,
  liveDrawings,
  MAX_FREE_POINTS,
  MAX_LIVE_PER_AUTHOR,
  parseGeometry,
  validCapFields,
  validExpiry,
  validStyle,
} from './record';
import { arrowFields, crew, drawOn, NEAR, QC, why } from './testUtils';

const W = T0 + MIN;
const enc = (pts: Pt[]) => encodePolyline(pts);

describe('drw colours', () => {
  it('the wire palette size matches the member palette (kept apart so core/team needs no UI)', () => {
    expect(COLOUR_COUNT).toBe(MEMBER_COLORS.length);
  });
});

describe('drw geometry', () => {
  it('accepts each shape with its point count, inside 50 km', () => {
    expect(parseGeometry('free', enc([QC, NEAR]), undefined)).toHaveLength(2);
    expect(parseGeometry('arrow', enc([QC, NEAR]), undefined)).toHaveLength(2);
    expect(parseGeometry('circle', enc([QC]), 85.2)).toHaveLength(1);
    expect(parseGeometry('rect', enc([QC, NEAR, QC, NEAR]), undefined)).toHaveLength(4);
    // A stroke in progress may hold one point.
    expect(parseGeometry('free', enc([QC]), undefined, 1)).toHaveLength(1);
  });

  it('refuses wrong counts, kinds, radii, junk and anything over 50 km', () => {
    expect(parseGeometry('free', enc([QC]), undefined)).toBeNull();
    expect(parseGeometry('arrow', enc([QC, NEAR, QC]), undefined)).toBeNull();
    expect(parseGeometry('rect', enc([QC, NEAR, QC]), undefined)).toBeNull();
    expect(parseGeometry('blob', enc([QC, NEAR]), undefined)).toBeNull();
    expect(parseGeometry('free', 42, undefined)).toBeNull();
    expect(parseGeometry('free', 'x'.repeat(6_001), undefined)).toBeNull();
    expect(parseGeometry('free', '\u0001\u0002', undefined)).toBeNull();
    expect(parseGeometry('circle', enc([QC]), undefined)).toBeNull();
    expect(parseGeometry('circle', enc([QC]), 0)).toBeNull();
    expect(parseGeometry('circle', enc([QC]), 25_001)).toBeNull();
    expect(parseGeometry('circle', enc([QC]), 25_000)).not.toBeNull();
    expect(parseGeometry('arrow', enc([QC, NEAR]), 5)).toBeNull();
    const far = destination(QC, 90, 50_500);
    expect(parseGeometry('arrow', enc([QC, far]), undefined)).toBeNull();
    const ok = destination(QC, 90, 49_000);
    expect(parseGeometry('arrow', enc([QC, ok]), undefined)).not.toBeNull();
    // Across the antimeridian, a short arrow is short.
    expect(
      parseGeometry(
        'arrow',
        enc([
          [179.99, 0],
          [-179.99, 0],
        ]),
        undefined,
      ),
    ).not.toBeNull();
    const many = Array.from({ length: MAX_FREE_POINTS + 1 }, (_, i): Pt => [
      QC[0] + i * 1e-5,
      QC[1],
    ]);
    expect(parseGeometry('free', enc(many), undefined)).toBeNull();
    expect(parseGeometry('free', enc(many.slice(1)), undefined)).toHaveLength(MAX_FREE_POINTS);
  });
});

describe('drw style and expiry', () => {
  const style = (over: Record<string, unknown>) =>
    validStyle({ sh: 'free', c: 0, w: 1, d: true, ...over } as never);

  it('checks colour index, width, dash, and arrow heads on arrows only', () => {
    expect(style({})).toBe(true);
    expect(style({ c: 7, w: 3 })).toBe(true);
    expect(style({ c: 8 })).toBe(false);
    expect(style({ c: -1 })).toBe(false);
    expect(style({ c: 1.5 })).toBe(false);
    expect(style({ c: '#FF0000' })).toBe(false);
    expect(style({ w: 4 })).toBe(false);
    expect(style({ d: 1 })).toBe(false);
    expect(style({ ht: 'fill' })).toBe(false);
    expect(style({ hs: 2 })).toBe(false);
    expect(style({ sh: 'arrow', ht: 'both', hs: 3 })).toBe(true);
    expect(style({ sh: 'arrow', ht: 'barbed', hs: 3 })).toBe(false);
    expect(style({ sh: 'arrow', ht: 'open', hs: 0 })).toBe(false);
  });

  it('x is null or within (created, created + 4 h + 1 min]', () => {
    expect(validExpiry(null, W)).toBe(true);
    expect(validExpiry(W, W)).toBe(false);
    expect(validExpiry(W + 1, W)).toBe(true);
    expect(validExpiry(W + 4 * HOUR + MIN, W)).toBe(true);
    expect(validExpiry(W + 4 * HOUR + MIN + 1, W)).toBe(false);
    expect(validExpiry(W + 0.5, W)).toBe(false);
    expect(validExpiry('soon', W)).toBe(false);
  });

  it('a write is full (every field) or a note alone; anything else is malformed', () => {
    expect(drawWrite(arrowFields(W), W)).toBe('full');
    expect(drawWrite(arrowFields(W, null, { tx: 'Go around the ridge' }), W)).toBe('full');
    expect(drawWrite({ tx: 'Here' }, W)).toBe('note');
    expect(drawWrite({ tx: '' }, W)).toBe('note');
    expect(drawWrite({ tx: 'x'.repeat(41) }, W)).toBeNull();
    expect(drawWrite({ tx: 3 }, W)).toBeNull();
    expect(drawWrite(arrowFields(W, 30_000, { zz: 1 }), W)).toBeNull();
    const { d: _d, ...noDash } = arrowFields(W);
    expect(drawWrite(noDash, W)).toBeNull();
    expect(drawWrite(arrowFields(W, 30_000, { g: enc([QC]) }), W)).toBeNull();
    expect(drawWrite(arrowFields(W, 30_000, { c: 9 }), W)).toBeNull();
    expect(drawWrite(arrowFields(W, 5 * HOUR), W)).toBeNull();
    expect(drawWrite({ x: null }, W)).toBeNull();
  });

  it('counts live shapes, pruning the expired ones', () => {
    expect(liveDrawings(undefined, W)).toBe(0);
    const mine = new Map<string, number | null>([
      ['a', W - 1],
      ['b', W],
      ['c', W + 1],
      ['d', null],
    ]);
    expect(liveDrawings(mine, W)).toBe(2);
    expect([...mine.keys()]).toEqual(['c', 'd']);
  });

  it('cap flags are 0 or 1', () => {
    expect(validCapFields({ pen: 1 })).toBe(true);
    expect(validCapFields({ pen: 0, later: 1 })).toBe(true);
    expect(validCapFields({ pen: 2 })).toBe(false);
    expect(validCapFields({ pen: true })).toBe(false);
  });
});

describe('drw in the fold (adversarial)', () => {
  it('members draw; guests cannot; the shape reaches everyone', () => {
    const { w, bob, rb, rg, sync } = crew();
    const op = drawOn(rb, T0 + MIN, 'a1');
    const g = drawOn(rg, T0 + MIN, 'g1');
    sync(T0 + MIN + 1000);
    expect(why(w.root, op.id)).toBeUndefined();
    expect(why(w.root, g.id)).toBe('forbidden');
    const rec = w.root.data().entities.get(entityKey('drw', 'a1', bob.id))!;
    expect(isLive(rec.state)).toBe(true);
    expect(visibleFields(rec.state)['sh']).toBe('arrow');
  });

  it('later only the note changes, and only by the owner', () => {
    const { w, bob, rb, re, sync } = crew();
    drawOn(rb, T0 + MIN, 'a1', null);
    sync(T0 + MIN + 1);
    const note = rb.write(T0 + 2 * MIN, 'e.set', { k: 'drw', id: 'a1', f: { tx: 'Ridge' } })!;
    const move = rb.write(T0 + 2 * MIN, 'e.set', {
      k: 'drw',
      id: 'a1',
      f: { tx: 'x', c: 3 },
    })!;
    const redraw = drawOn(rb, T0 + 2 * MIN, 'a1', null);
    // Eve cannot reach Bob's shape: `o` is refused for drw, and her own id is hers.
    const eveO = re.write(T0 + 2 * MIN, 'e.set', {
      k: 'drw',
      id: 'a1',
      o: bob.id,
      f: { tx: 'mine now' },
    })!;
    const eveNote = re.write(T0 + 2 * MIN, 'e.set', { k: 'drw', id: 'a1', f: { tx: 'hi' } })!;
    const badNote = rb.write(T0 + 2 * MIN, 'e.set', {
      k: 'drw',
      id: 'a1',
      f: { tx: 'y'.repeat(41) },
    })!;
    sync(T0 + 3 * MIN);
    expect(why(w.root, note.id)).toBeUndefined();
    expect(why(w.root, move.id)).toBe('invalid');
    expect(why(w.root, redraw.id)).toBe('forbidden');
    expect(why(w.root, eveO.id)).toBe('invalid');
    expect(why(w.root, eveNote.id)).toBe('forbidden'); // no note on a shape that isn't there
    expect(why(w.root, badNote.id)).toBe('invalid');
    const rec = w.root.data().entities.get(entityKey('drw', 'a1', bob.id))!;
    expect(visibleFields(rec.state)['tx']).toBe('Ridge');
    expect(visibleFields(rec.state)['c']).toBe(1);
  });

  it('the author or an admin deletes; others cannot; Undo re-sets and revives', () => {
    const { w, bob, rb, re, sync } = crew();
    const wall = T0 + MIN;
    drawOn(rb, wall, 'a1', 30 * MIN);
    sync(wall + 1);
    const eveDel = re.write(T0 + 2 * MIN, 'e.del', { k: 'drw', id: 'a1', o: bob.id })!;
    sync(T0 + 2 * MIN + 1);
    expect(why(w.root, eveDel.id)).toBe('forbidden');
    rb.write(T0 + 3 * MIN, 'e.del', { k: 'drw', id: 'a1' });
    sync(T0 + 3 * MIN + 1);
    const key = entityKey('drw', 'a1', bob.id);
    expect(isLive(w.root.data().entities.get(key)!.state)).toBe(false);
    // Undo of Clear mine: the same fields again.
    const undo = rb.write(T0 + 3 * MIN + 5000, 'e.set', {
      k: 'drw',
      id: 'a1',
      f: arrowFields(wall, 30 * MIN),
    })!;
    sync(T0 + 4 * MIN);
    expect(why(w.root, undo.id)).toBeUndefined();
    expect(isLive(w.root.data().entities.get(key)!.state)).toBe(true);
    w.root.write(T0 + 5 * MIN, 'e.del', { k: 'drw', id: 'a1', o: bob.id });
    sync(T0 + 5 * MIN + 1);
    expect(isLive(rb.data().entities.get(key)!.state)).toBe(false);
  });

  it('a note on a deleted shape is refused (it is not there)', () => {
    const { w, rb, sync } = crew();
    drawOn(rb, T0 + MIN, 'a1', null);
    rb.write(T0 + 2 * MIN, 'e.del', { k: 'drw', id: 'a1' });
    const note = rb.write(T0 + 3 * MIN, 'e.set', { k: 'drw', id: 'a1', f: { tx: 'late' } })!;
    sync(T0 + 4 * MIN);
    expect(why(w.root, note.id)).toBe('forbidden');
  });

  it('at most 30 live per author: the fold ignores more; expired and deleted ones free a slot', () => {
    const { w, rb, re, sync } = crew();
    for (let i = 0; i < MAX_LIVE_PER_AUTHOR; i++) drawOn(rb, T0 + MIN + i, `s${i}`, 10 * MIN);
    const over = drawOn(rb, T0 + MIN + 100, 'over', null);
    // Someone else's cap is their own.
    const eve = drawOn(re, T0 + MIN + 100, 'e1', null);
    // After a delete, one fits again.
    rb.write(T0 + 2 * MIN, 'e.del', { k: 'drw', id: 's0' });
    const afterDel = drawOn(rb, T0 + 2 * MIN + 1, 'afterDel', null);
    const full = drawOn(rb, T0 + 2 * MIN + 2, 'full', null);
    // Once the 10-min shapes expire (against each op's own time), slots free up.
    const later = drawOn(rb, T0 + 12 * MIN, 'later', null);
    sync(T0 + 12 * MIN + 1);
    expect(why(w.root, over.id)).toBe('forbidden');
    expect(why(w.root, eve.id)).toBeUndefined();
    expect(why(w.root, afterDel.id)).toBeUndefined();
    expect(why(w.root, full.id)).toBe('forbidden');
    expect(why(w.root, later.id)).toBeUndefined();
  });

  it('refuses an expiry before the op, or past 4 h, measured on the op’s own stamp', () => {
    const { w, rb, sync } = crew();
    const wall = T0 + MIN;
    const past = rb.write(wall, 'e.set', {
      k: 'drw',
      id: 'p',
      f: arrowFields(wall - 10_000, 5_000),
    })!;
    const long = drawOn(rb, wall + 1, 'l', 4 * HOUR + 2 * MIN);
    sync(wall + 2);
    expect(why(w.root, past.id)).toBe('invalid');
    expect(why(w.root, long.id)).toBe('invalid');
  });
});

describe('authorizeRecord for drw and cap (direct)', () => {
  it('refuses `o` on either (the fold refuses it earlier, at parse)', () => {
    const get = () => undefined;
    const base = { id: 'a', author: 'me', role: 'member' as const };
    expect(
      authorizeRecord({ ...base, kind: 'drw', o: 'x', f: arrowFields(W) }, get, emptyIndex(), W),
    ).toBe('invalid');
    expect(
      authorizeRecord(
        { ...base, kind: 'drw', o: undefined, f: arrowFields(W) },
        get,
        emptyIndex(),
        W,
      ),
    ).toEqual({
      owner: 'me',
    });
    expect(
      authorizeRecord({ ...base, kind: 'drw', o: undefined, f: arrowFields(W) }, get, undefined, W),
    ).toEqual({
      owner: 'me',
    });
    expect(authorizeRecord({ ...base, id: 'me', kind: 'cap', o: 'me', f: { pen: 1 } }, get)).toBe(
      'invalid',
    );
    expect(
      authorizeRecord({ ...base, id: 'me', kind: 'cap', o: undefined, f: { pen: 1 } }, get),
    ).toEqual({
      owner: 'me',
    });
  });
});

describe('cap records in the fold', () => {
  it('one per member under its own id; guests advertise too; nothing else', () => {
    const { w, bob, gus, rb, rg, sync } = crew();
    const mine = rb.write(T0 + MIN, 'e.set', { k: 'cap', id: bob.id, f: { pen: 1 } })!;
    const guest = rg.write(T0 + MIN, 'e.set', { k: 'cap', id: gus.id, f: { pen: 1 } })!;
    const other = rb.write(T0 + MIN, 'e.set', { k: 'cap', id: gus.id, f: { pen: 1 } })!;
    const bad = rb.write(T0 + MIN, 'e.set', { k: 'cap', id: bob.id, f: { pen: 'yes' } })!;
    const withO = rb.write(T0 + MIN, 'e.set', {
      k: 'cap',
      id: bob.id,
      o: bob.id,
      f: { pen: 1 },
    })!;
    sync(T0 + 2 * MIN);
    expect(why(w.root, mine.id)).toBeUndefined();
    expect(why(w.root, guest.id)).toBeUndefined();
    expect(why(w.root, other.id)).toBe('invalid');
    expect(why(w.root, bad.id)).toBe('invalid');
    expect(why(w.root, withO.id)).toBe('invalid'); // `o` is not allowed on cap
  });
});
