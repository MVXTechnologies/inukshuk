import { setOp, deleteOp, mergeEntity } from '@core/team/crdt';
import { emptyData, type EntityRecord } from '@core/team/data';
import { T0, MIN, HOUR } from '@core/team/testing/fixtures';
import { encodePolyline } from '@core/trails/polyline';

import {
  drawClock,
  drawViewWork,
  fullNotes,
  MAX_SHOWN_LIFE_MS,
  MAX_DRAWN,
  recencyBand,
  shapeOf,
  shapesOf,
  teamShapes,
  type DrawShape,
} from './view';
import { arrowFields, crew, drawOn, QC } from './testUtils';

const stamp = (wall: number) => ({ wall, counter: 0, author: 'a' });
const rec = (f: Record<string, unknown>, over: Partial<EntityRecord> = {}): EntityRecord => ({
  kind: 'drw',
  id: 'x',
  owner: 'me',
  state: setOp(f as never, stamp(T0)),
  ...over,
});

describe('shapes from the fold', () => {
  it('reads each kind with its style, note and life', () => {
    const arrow = shapeOf(rec(arrowFields(T0, 30_000, { tx: 'Go' })))!;
    expect(arrow).toMatchObject({
      key: 'me:x',
      sh: 'arrow',
      ht: 'fill',
      hs: 2,
      c: 1,
      w: 2,
      d: false,
      tx: 'Go',
      created: T0,
      expires: T0 + 30_000,
    });
    const circle = shapeOf(
      rec({ sh: 'circle', g: encodePolyline([QC]), r: 40, c: 0, w: 1, d: true, x: null }),
    )!;
    expect(circle).toMatchObject({ sh: 'circle', r: 40, expires: null, tx: '' });
    expect(circle.ht).toBeUndefined();
  });

  it('skips what is not a drawable live drw', () => {
    expect(shapeOf(rec(arrowFields(T0), { kind: 'rly' }))).toBeNull();
    expect(shapeOf(rec(arrowFields(T0), { owner: undefined }))).toBeNull();
    expect(shapeOf(rec({}, { state: deleteOp(stamp(T0)) }))).toBeNull();
    const gone = mergeEntity(setOp(arrowFields(T0) as never, stamp(T0)), deleteOp(stamp(T0 + 1)));
    expect(shapeOf(rec({}, { state: gone }))).toBeNull();
    expect(shapeOf(rec({ ...arrowFields(T0), g: '' }))).toBeNull();
    expect(shapeOf(rec({ ...arrowFields(T0), c: 99 }))).toBeNull();
  });

  it('caps the life at 4 h + 1 min from the first write, whatever `x` says', () => {
    const long = shapeOf(rec(arrowFields(T0, 10 * HOUR)))!;
    expect(long.expires).toBe(T0 + MAX_SHOWN_LIFE_MS);
    expect(shapeOf(rec(arrowFields(T0, HOUR)))!.expires).toBe(T0 + HOUR);
  });

  it('a delete stamped before the first write deletes; a later re-set (Undo) revives', () => {
    const at = setOp(arrowFields(T0 + HOUR) as never, stamp(T0 + HOUR));
    expect(shapeOf(rec({}, { state: mergeEntity(at, deleteOp(stamp(T0))) }))).toBeNull();
    const undo = mergeEntity(
      mergeEntity(setOp(arrowFields(T0) as never, stamp(T0)), deleteOp(stamp(T0 + 1))),
      setOp(arrowFields(T0) as never, stamp(T0 + 2)),
    );
    expect(shapeOf(rec({}, { state: undo }))).not.toBeNull();
  });

  it('only a note visible (the shape was deleted before it): nothing to draw', () => {
    const st = mergeEntity(
      mergeEntity(setOp(arrowFields(T0) as never, stamp(T0)), deleteOp(stamp(T0 + 1))),
      setOp({ tx: 'late' }, stamp(T0 + 2)),
    );
    expect(shapeOf(rec({}, { state: st }))).toBeNull();
  });

  it('re-decodes when the shape kind or radius changed under the same geometry', () => {
    const first = setOp(
      { sh: 'circle', g: encodePolyline([QC]), r: 40, c: 0, w: 1, d: true, x: null },
      stamp(T0),
    );
    const r = rec({}, { state: first });
    drawViewWork.decodes = 0;
    expect(shapeOf(r)!.r).toBe(40);
    expect(shapeOf(r)!.r).toBe(40);
    expect(drawViewWork.decodes).toBe(1);
    const wider = rec({}, { state: mergeEntity(first, setOp({ r: 60 }, stamp(T0 + 1))) });
    expect(shapeOf(wider)!.r).toBe(60);
    expect(drawViewWork.decodes).toBe(2);
  });

  it('a malformed shape takes no slot: the author’s next one is drawn', () => {
    const data = emptyData();
    const put = (id: string, f: Record<string, unknown>, wall: number) =>
      data.entities.set(`drw:me:${id}`, rec(f, { id, state: setOp(f as never, stamp(wall)) }));
    put('ok', arrowFields(T0, null), T0);
    put('bad', { ...arrowFields(T0, null), c: 99 }, T0 + 1);
    expect(teamShapes(data, T0 + 2).map((s) => s.id)).toEqual(['ok']);
  });

  it('drops expired shapes against the replica clock, keeps Never', () => {
    const { w, rb, sync } = crew();
    drawOn(rb, T0 + MIN, 'short', 10_000);
    drawOn(rb, T0 + MIN, 'never', null);
    drawOn(rb, T0 + MIN, 'gone', null);
    rb.write(T0 + MIN + 1, 'e.del', { k: 'drw', id: 'gone' });
    rb.write(T0 + MIN + 1, 'e.set', { k: 'rly', id: 'r', f: { la: 46.8, lo: -71.2 } });
    sync(T0 + MIN + 2);
    const data = w.root.data();
    expect(
      teamShapes(data, T0 + MIN + 5_000)
        .map((s) => s.id)
        .sort(),
    ).toEqual(['never', 'short']);
    expect(teamShapes(data, T0 + MIN + 10_000).map((s) => s.id)).toEqual(['never']);
    // A phone whose clock runs slow still drops it: the clock is the replica's HLC.
    expect(drawClock(T0 + MIN + 20_000, T0)).toBe(T0 + MIN + 20_000);
    expect(drawClock(T0, T0 + 5)).toBe(T0 + 5);
    expect(teamShapes(data, drawClock(w.root.writer.cursor.hlc.wall + 20_000, T0))).toHaveLength(1);
  });

  it('draws the 60 newest, oldest first; per owner on request', () => {
    const { w, rb, re, sync, bob } = crew();
    for (let i = 0; i < 30; i++) drawOn(rb, T0 + MIN + i * 10, `b${i}`, null);
    for (let i = 0; i < 30; i++) drawOn(re, T0 + MIN + 5 + i * 10, `e${i}`, null);
    drawOn(re, T0 + 2 * MIN, 'late', null); // Eve's 31st: refused by the fold
    sync(T0 + 3 * MIN);
    const shapes = teamShapes(w.root.data(), T0 + 3 * MIN);
    expect(shapes).toHaveLength(MAX_DRAWN);
    expect(shapes[0]!.id).toBe('b0');
    expect(shapes[59]!.id).toBe('e29');
    expect(shapesOf(shapes, bob.id)).toHaveLength(30);
    // Ties on time break on the key, the same everywhere.
    const tie = [
      { key: 'b', created: 1 },
      { key: 'a', created: 1 },
    ] as DrawShape[];
    expect(fullNotes(tie, undefined, undefined)).toEqual(new Set(['a', 'b']));
  });

  it('a 61st shape pushes the oldest off the map', () => {
    const { w, rb, re, sync } = crew();
    for (let i = 0; i < 30; i++) drawOn(rb, T0 + MIN + i, `b${i}`, null);
    for (let i = 0; i < 30; i++) drawOn(re, T0 + MIN + 100 + i, `e${i}`, null);
    drawOn(w.root, T0 + MIN + 200, 'o', null);
    sync(T0 + 2 * MIN);
    const shapes = teamShapes(w.root.data(), T0 + 2 * MIN);
    expect(shapes).toHaveLength(60);
    expect(shapes.map((s) => s.id)).not.toContain('b0');
    expect(shapes[59]!.id).toBe('o');
  });
});

describe('order and notes', () => {
  it('recency bands: 0 for the oldest ten of sixty … 5 for the newest ten', () => {
    expect(recencyBand(59, 60)).toBe(5);
    expect(recencyBand(50, 60)).toBe(5);
    expect(recencyBand(49, 60)).toBe(4);
    expect(recencyBand(0, 60)).toBe(0);
    expect(recencyBand(2, 3)).toBe(5);
    expect(recencyBand(0, 3)).toBe(5);
  });

  it('full notes: the 3 newest, mine, and the selected one', () => {
    const mk = (key: string, created: number, owner = 'x') =>
      ({ key, created, owner }) as DrawShape;
    const shapes = [mk('a', 1, 'me'), mk('b', 2), mk('c', 3), mk('d', 4), mk('e', 5), mk('f', 6)];
    expect(fullNotes(shapes, 'me', 'b')).toEqual(new Set(['d', 'e', 'f', 'a', 'b']));
    expect(fullNotes(shapes, undefined, undefined)).toEqual(new Set(['d', 'e', 'f']));
  });
});
