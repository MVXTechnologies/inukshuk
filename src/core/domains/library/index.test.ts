import { visibleFields } from '@core/team/crdt';
import { recordKey } from '@core/group/registry';

import { inTrash, LIBRARY_DOMAIN, libraryPlugin, libraryRegistry } from './index';
import {
  CURSOR_ID,
  LAC,
  LCM,
  LFO,
  LIBRARY_KINDS,
  LIT,
  MAX_DESCRIPTION,
  MAX_FOLDERS,
  MAX_INLINE_GEOMETRY,
  MAX_ITEMS,
  MAX_NAME,
} from './kinds';
import { LibSim, mid, MIN, OWNER, ROOT, T0 } from './testUtils';
import { comment, newFolder, newItem, purge, setCursor } from './writes';

const ED = mid('ed');
const VW = mid('vw');
const MG = mid('mg');
const at = (n: number) => T0 + n * MIN;

/** Owner, a manager, an editor and a viewer; the shared root folder exists. */
function world() {
  const sim = new LibSim({ [MG]: 'admin', [ED]: 'member', [VW]: 'guest' });
  sim.meta(at(0));
  sim.set(OWNER, at(0) + 1, newFolder(ROOT, 'Gaspésie 2026'));
  return sim;
}

describe('registry', () => {
  it('registers the group kinds and the four library kinds, frozen', () => {
    const r = libraryRegistry();
    expect(r.isFrozen).toBe(true);
    expect(r.kinds()).toEqual(['gmeta', 'irdv', 'net', ...LIBRARY_KINDS].sort());
    expect(r.forKind(LIT)?.id).toBe(LIBRARY_DOMAIN);
    expect(r.forKind('wpt')).toBeUndefined();
    expect(libraryRegistry()).toBe(r);
    expect(libraryPlugin.baseStamps).toBe(true);
    expect(libraryPlugin.lane?.(LIT, {})).toBe(1);
  });

  it('a team kind in a library group is skipped as unknown (a newer or other domain)', () => {
    const sim = world();
    const op = sim.set(ED, at(1), { k: 'wpt', id: 'w1', f: { n: 'x' } });
    expect(sim.why(op.id)).toBe('unknown');
  });
});

describe('who writes what', () => {
  it('editors create, edit and soft-delete; viewers cannot', () => {
    const sim = world();
    const ok = sim.set(ED, at(1), newItem('i1', 'wpt', 'Belvédère', ROOT, { ll: [-65.9, 48.9] }));
    const view = sim.set(VW, at(2), newItem('i2', 'wpt', 'Nope'));
    const viewEdit = sim.set(VW, at(3), { k: LIT, id: 'i1', f: { n: 'x' } });
    const trash = sim.set(ED, at(4), { k: LIT, id: 'i1', f: { rm: 1 } });
    expect(sim.why(ok.id)).toBeUndefined();
    expect(sim.why(view.id)).toBe('forbidden');
    expect(sim.why(viewEdit.id)).toBe('forbidden');
    expect(sim.why(trash.id)).toBeUndefined();
  });

  it('viewers comment and keep their cursor; nobody writes as someone else', () => {
    const sim = world();
    const c = sim.set(VW, at(1), comment('c1', ROOT, 'Nice spot'));
    const cur = sim.set(VW, at(2), setCursor(at(2)));
    const badCursorId = sim.set(VW, at(3), { k: LAC, id: 'x', f: { seen: 1 } });
    const asOther = sim.set(ED, at(4), { k: LCM, id: 'c1', o: VW, f: { tx: 'hijack' } } as never);
    expect(sim.why(c.id)).toBeUndefined();
    expect(sim.why(cur.id)).toBeUndefined();
    expect(sim.why(badCursorId.id)).toBe('invalid');
    expect(sim.why(asOther.id)).toBe('invalid');
    const data = sim.fold();
    expect(data.entities.get(recordKey(true, LCM, 'c1', VW))?.owner).toBe(VW);
    expect(data.entities.get(recordKey(true, LAC, CURSOR_ID, VW))).toBeDefined();
  });

  it('comments: first write names the record (once), text is checked, deletes by writer or manager', () => {
    const sim = world();
    const noOn = sim.set(VW, at(1), { k: LCM, id: 'c0', f: { tx: 'x' } });
    sim.set(VW, at(2), comment('c1', ROOT, 'a'));
    const edit = sim.set(VW, at(3), { k: LCM, id: 'c1', f: { tx: 'b' } });
    const move = sim.set(VW, at(4), { k: LCM, id: 'c1', f: { on: 'other' } });
    const long = sim.set(VW, at(5), comment('c2', ROOT, 'x'.repeat(1001)));
    sim.set(ED, at(5) + 1, comment('c3', ROOT, 'mine'));
    const byOther = sim.del(ED, at(6), { k: LCM, id: 'c1', o: VW });
    const byMgr = sim.del(MG, at(7), { k: LCM, id: 'c3', o: ED });
    const own = sim.del(VW, at(8), { k: LCM, id: 'c1' });
    const cursorDel = sim.del(VW, at(9), { k: LAC, id: CURSOR_ID });
    expect(sim.why(noOn.id)).toBe('invalid');
    expect(sim.why(edit.id)).toBeUndefined();
    expect(sim.why(move.id)).toBe('forbidden');
    expect(sim.why(long.id)).toBe('invalid');
    expect(sim.why(byOther.id)).toBe('forbidden');
    expect(sim.why(byMgr.id)).toBeUndefined();
    expect(sim.why(own.id)).toBeUndefined();
    expect(sim.why(cursorDel.id)).toBeUndefined();
  });
});

describe('fields', () => {
  it('first writes name the record; an item type never changes', () => {
    const sim = world();
    const noName = sim.set(ED, at(1), { k: LFO, id: 'f1', f: { p: ROOT } });
    const noType = sim.set(ED, at(2), { k: LIT, id: 'i1', f: { n: 'x' } });
    sim.set(ED, at(3), newItem('i2', 'trk', 'Ride'));
    const retype = sim.set(ED, at(4), { k: LIT, id: 'i2', f: { t: 'wpt' } });
    const same = sim.set(ED, at(5), { k: LIT, id: 'i2', f: { t: 'trk', n: 'Ride 2' } });
    const self = sim.set(ED, at(6), { k: LFO, id: 'f2', f: { n: 'x', p: 'f2' } });
    expect(sim.why(noName.id)).toBe('invalid');
    expect(sim.why(noType.id)).toBe('invalid');
    expect(sim.why(retype.id)).toBe('forbidden');
    expect(sim.why(same.id)).toBeUndefined();
    expect(sim.why(self.id)).toBe('invalid');
  });

  it('checks every known field and keeps unknown ones (forward-lenient)', () => {
    const good = {
      n: 'Ride',
      p: ROOT,
      o: 2.5,
      d: '',
      sty: { c: '#AABBCC', s: 'XL', w: 3, future: 1 },
      g: '_p~iF~ps|U_ulLnnqC',
      ll: [-71.2, 46.8],
      el: 120,
      ic: 'future-icon',
      cat: 'cpa-abc123',
      m: { size: 10 },
      rm: 0,
    };
    const bad: Record<string, unknown>[] = [
      { n: '' },
      { n: ' ' },
      { n: 'x'.repeat(MAX_NAME + 1) },
      { p: '' },
      { p: 'a/b' },
      { o: 'first' },
      { d: 'x'.repeat(MAX_DESCRIPTION + 1) },
      { sty: [] },
      { sty: null },
      { sty: { c: 'red' } },
      { sty: { s: 'XXL' } },
      { sty: { w: 0 } },
      { sty: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 1])) },
      { g: '' },
      { g: 'has space' },
      { g: 'a'.repeat(MAX_INLINE_GEOMETRY + 1) },
      { ll: [200, 0] },
      { ll: [0, 91] },
      { ll: [0] },
      { ll: ['x', 1] },
      { el: 50_000 },
      { ic: 'Bad Icon' },
      { cat: 'https://evil.example/map.pdf' },
      { cat: '-x' },
      { rm: 2 },
      { t: 'pdf' },
      { b: { x: [1, 2] } },
    ];
    const sim = world();
    const ok = sim.set(ED, at(1), newItem('i1', 'trk', 'Ride', ROOT, good));
    expect(sim.why(ok.id)).toBeUndefined();
    bad.forEach((f, i) => {
      const op = sim.set(ED, at(2 + i), { k: LIT, id: 'i1', f: f as never });
      expect([JSON.stringify(f), sim.why(op.id)]).toEqual([JSON.stringify(f), 'invalid']);
    });
    expect(visibleFields(sim.fold().entities.get(recordKey(false, LIT, 'i1'))!.state)['m']).toEqual(
      { size: 10 },
    );
    const badCursor = sim.set(VW, at(60), { k: LAC, id: CURSOR_ID, f: { seen: -1 } });
    expect(sim.why(badCursor.id)).toBe('invalid');
  });
});

describe('the shared root', () => {
  it('is never trashed, moved or purged; it can be renamed', () => {
    const sim = world();
    sim.set(ED, at(1), newFolder('f1', 'Sub', ROOT));
    const rename = sim.set(ED, at(2), { k: LFO, id: ROOT, f: { n: 'Gaspésie' } });
    const trash = sim.set(MG, at(3), { k: LFO, id: ROOT, f: { rm: 1 } });
    const move = sim.set(MG, at(4), { k: LFO, id: ROOT, f: { p: 'f1' } });
    const purgeIt = sim.del(OWNER, at(5), purge(LFO, ROOT));
    expect(sim.why(rename.id)).toBeUndefined();
    expect(sim.why(trash.id)).toBe('forbidden');
    expect(sim.why(move.id)).toBe('forbidden');
    expect(sim.why(purgeIt.id)).toBe('forbidden');
  });
});

describe('purge', () => {
  it('a manager purges what is in the trash, itself or under a trashed folder; nobody else', () => {
    const sim = world();
    sim.set(ED, at(1), newFolder('f1', 'Old', ROOT));
    sim.set(ED, at(2), newItem('i1', 'wpt', 'In old', 'f1'));
    sim.set(ED, at(3), newItem('i2', 'wpt', 'Live', ROOT));
    const live = sim.del(MG, at(4), purge(LIT, 'i2'));
    sim.set(ED, at(5), { k: LFO, id: 'f1', f: { rm: 1 } });
    const byEditor = sim.del(ED, at(6), purge(LIT, 'i1'));
    const inside = sim.del(MG, at(7), purge(LIT, 'i1'));
    const missing = sim.del(MG, at(8), purge(LIT, 'nope'));
    const folder = sim.del(MG, at(9), purge(LFO, 'f1'));
    const again = sim.del(MG, at(10), purge(LFO, 'f1'));
    const withO = sim.del(MG, at(11), { k: LIT, id: 'i2', o: ED });
    expect(sim.why(live.id)).toBe('forbidden');
    expect(sim.why(byEditor.id)).toBe('forbidden');
    expect(sim.why(inside.id)).toBeUndefined();
    expect(sim.why(missing.id)).toBe('forbidden');
    expect(sim.why(folder.id)).toBeUndefined();
    expect(sim.why(again.id)).toBe('forbidden');
    expect(sim.why(withO.id)).toBe('invalid');
  });

  it('a purged record never comes back; a write folded before the purge stays hidden', () => {
    const sim = world();
    sim.set(ED, at(1), newItem('i1', 'wpt', 'x', ROOT));
    sim.set(ED, at(2), { k: LIT, id: 'i1', f: { rm: 1 } });
    sim.del(MG, at(3), purge(LIT, 'i1'));
    const revive = sim.set(ED, at(4), { k: LIT, id: 'i1', f: { rm: 0, n: 'back' } });
    expect(sim.why(revive.id)).toBe('forbidden');
    expect(sim.look().view.items.has('i1')).toBe(false);
  });

  it('inTrash follows raw parents, cycle-safe, and sees purged folders', () => {
    const sim = world();
    sim.set(ED, at(1), newFolder('a', 'A', ROOT));
    sim.set(ED, at(2), newFolder('b', 'B', 'a'));
    sim.set(ED, at(3), { k: LFO, id: 'a', f: { p: 'b' } });
    sim.set(ED, at(4), newItem('i', 'wpt', 'x', 'b'));
    const data = sim.fold();
    expect(inTrash(data, LIT, 'i')).toBe(false);
    expect(inTrash(data, LIT, 'none')).toBe(false);
    sim.set(ED, at(5), { k: LFO, id: 'a', f: { rm: 1 } });
    expect(inTrash(sim.fold(), LIT, 'i')).toBe(true);
  });
});

describe('limits', () => {
  it(`at most ${MAX_FOLDERS} folders and ${MAX_ITEMS} items; a purge frees a slot`, () => {
    const sim = world();
    // The root is folder #1.
    for (let i = 1; i < MAX_FOLDERS; i++) sim.set(ED, at(1) + i, newFolder(`f${i}`, 'F', ROOT));
    const oneTooMany = sim.set(ED, at(2), newFolder('fx', 'F', ROOT));
    for (let i = 0; i < MAX_ITEMS; i++) sim.set(ED, at(3) + i, newItem(`i${i}`, 'wpt', 'W', ROOT));
    const itemTooMany = sim.set(ED, at(4), newItem('ix', 'wpt', 'W', ROOT));
    sim.set(ED, at(5), { k: LIT, id: 'i0', f: { rm: 1 } });
    const stillFull = sim.set(ED, at(6), newItem('iy', 'wpt', 'W', ROOT));
    sim.del(MG, at(7), purge(LIT, 'i0'));
    const fits = sim.set(ED, at(8), newItem('iz', 'wpt', 'W', ROOT));
    const batch = sim.fold();
    const incremental = sim.foldIncremental();
    for (const data of [batch, incremental]) {
      const why = (id: string) => data.skipped.find((s) => s.id === id)?.why;
      expect(why(oneTooMany.id)).toBe('forbidden');
      expect(why(itemTooMany.id)).toBe('forbidden');
      expect(why(stillFull.id)).toBe('forbidden');
      expect(why(fits.id)).toBeUndefined();
    }
    expect(batch.skipped).toEqual(incremental.skipped);
  });

  it('counts a view it has not seen before from scratch (a rebuilt or restored view)', () => {
    const sim = world();
    sim.set(ED, at(1), newItem('i1', 'wpt', 'W', ROOT));
    const data = sim.fold();
    // A copy of the entity map is a new view to the counter: it must recount, not start at 0.
    const copy = { ...data, entities: new Map(data.entities) };
    const rec = copy.entities.get(recordKey(false, LIT, 'i1'))!;
    libraryPlugin.merged!(copy, rec, rec.state);
    libraryPlugin.merged!(copy, rec, undefined);
    libraryPlugin.merged!(copy, { ...rec, kind: LAC }, undefined);
    expect(
      libraryPlugin.authorize(
        {
          op: 'set',
          kind: LIT,
          id: 'new',
          f: { t: 'wpt', n: 'x' },
          o: undefined,
          author: ED,
          wall: at(2),
        },
        'member',
        copy,
        sim.state(),
      ),
    ).toEqual({ owner: undefined });
  });
});
