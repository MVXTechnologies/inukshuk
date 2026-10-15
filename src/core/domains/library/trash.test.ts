import { LFO, LIT, TRASH_MS } from './kinds';
import { MassDeleteDetector, MASS_DELETE_COUNT, MASS_DELETE_WINDOW_MS } from './massDelete';
import { LibSim, mid, MIN, OWNER, ROOT, T0 } from './testUtils';
import { expiredTrash, trashedBy, trashList } from './trash';
import { newFolder, newItem, purge, restoreAll, trash } from './writes';

const ED = mid('ed');
const MG = mid('mg');
const at = (n: number) => T0 + n * MIN;

function world() {
  const sim = new LibSim({ [ED]: 'member', [MG]: 'admin' });
  sim.meta(at(0));
  sim.set(OWNER, at(0) + 1, newFolder(ROOT, 'Shared'));
  sim.set(ED, at(1), newFolder('f', 'Trip', ROOT));
  sim.set(ED, at(2), newFolder('g', 'Day 1', 'f'));
  sim.set(ED, at(3), newItem('a', 'wpt', 'A', 'g'));
  sim.set(ED, at(4), newItem('b', 'wpt', 'B', 'f'));
  sim.set(ED, at(5), newItem('c', 'wpt', 'C', ROOT));
  return sim;
}

describe('30-day trash', () => {
  it('lists top-most trashed records, newest first, with their contents', () => {
    const sim = world();
    const h = () => sim.look().history;
    sim.set(ED, at(6), trash(h(), ED, LIT, 'a'));
    sim.set(ED, at(7), trash(h(), ED, LFO, 'f'));
    sim.set(ED, at(8), trash(h(), ED, LIT, 'c'));
    const { view } = sim.look();
    const list = trashList(view, at(9));
    expect(list.map((e) => [e.node.id, e.contents])).toEqual([
      ['c', 0],
      ['f', 3],
    ]);
    expect(list[1]!.since.wall).toBe(at(7));
    expect(list[1]!.expiresAt).toBe(at(7) + TRASH_MS);
    expect(trashList(view, at(7) + TRASH_MS).map((e) => e.node.id)).toEqual(['c']);
    expect(expiredTrash(view, at(8) + TRASH_MS).map((e) => e.node.id)).toEqual(['c', 'f']);
    expect(expiredTrash(view, at(9))).toEqual([]);
  });

  it('what a soft delete takes: itself and contents not trashed on their own', () => {
    const sim = world();
    const h = () => sim.look().history;
    sim.set(ED, at(6), trash(h(), ED, LIT, 'a'));
    const before = sim.look().view;
    const f = before.folders.get('f')!;
    expect(trashedBy(before, f).map((n) => n.id)).toEqual(['f', 'g', 'b']);
    sim.set(ED, at(6) + 1, newItem('a2', 'wpt', 'A2', 'g'));
    sim.set(ED, at(7), trash(h(), ED, LFO, 'g'));
    sim.set(ED, at(8), trash(h(), ED, LFO, 'f'));
    const after = sim.look().view;
    expect(trashedBy(after, after.folders.get('f')!).map((n) => n.id)).toEqual(['f', 'b']);
    expect(trashedBy(after, after.items.get('c')!).map((n) => n.id)).toEqual(['c']);
  });

  it('orphans of a purged folder stay in the trash, since their newest write', () => {
    const sim = world();
    sim.set(ED, at(6), trash(sim.look().history, ED, LFO, 'g'));
    sim.del(MG, at(7), purge(LFO, 'g'));
    const list = trashList(sim.look().view, at(8));
    expect(list.map((e) => [e.node.id, e.since.wall])).toEqual([['a', at(3)]]);
  });
});

describe('mass-delete alarm', () => {
  const recs = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `lit:${prefix}${i}`);

  it(`raises past ${MASS_DELETE_COUNT} records in ${MASS_DELETE_WINDOW_MS / MIN} min, then grows`, () => {
    const d = new MassDeleteDetector();
    for (let i = 0; i < MASS_DELETE_COUNT; i++)
      expect(d.note({ opId: `o${i}`, author: ED, at: T0 + i * 1000, records: [`lit:x${i}`] })).toBe(
        undefined,
      );
    // The same op again counts once.
    expect(d.note({ opId: 'o0', author: ED, at: T0 + 30_000, records: ['lit:z'] })).toBeUndefined();
    const alert = d.note({ opId: 'o20', author: ED, at: T0 + 40_000, records: ['lit:x20'] })!;
    expect(alert).toMatchObject({ author: ED, count: 21, from: T0, to: T0 + 40_000 });
    const grown = d.note({
      opId: 'o21',
      author: ED,
      at: T0 + 50_000,
      records: ['lit:x21', 'lit:x0'],
    })!;
    expect(grown.count).toBe(22);
    expect(d.alerts().map((a) => a.author)).toEqual([ED]);
    d.dismiss(ED);
    expect(d.alerts()).toEqual([]);
  });

  it('a folder of 500 items is one op but weighs 500; slow deletes never alarm', () => {
    const d = new MassDeleteDetector();
    expect(d.note({ opId: 'big', author: MG, at: T0, records: recs('f', 500) })!.count).toBe(500);
    const slow = new MassDeleteDetector();
    for (let i = 0; i < 100; i++)
      expect(
        slow.note({
          opId: `s${i}`,
          author: ED,
          at: T0 + i * MASS_DELETE_WINDOW_MS,
          records: recs(`s${i}`, 2),
        }),
      ).toBeUndefined();
    expect(slow.note({ opId: 'none', author: ED, at: T0, records: [] })).toBeUndefined();
    expect(slow.alerts()).toEqual([]);
  });

  it('authors are counted apart', () => {
    const d = new MassDeleteDetector(2, MIN);
    d.note({ opId: 'a', author: ED, at: T0, records: ['x', 'y'] });
    expect(d.note({ opId: 'b', author: MG, at: T0, records: ['z'] })).toBeUndefined();
    expect(d.note({ opId: 'c', author: ED, at: T0 + 1, records: ['w'] })!.records).toEqual([
      'x',
      'y',
      'w',
    ]);
    d.note({ opId: 'd', author: MG, at: T0, records: ['q', 'r'] });
    expect(d.alerts().map((a) => a.author)).toEqual([ED, MG].sort());
  });

  it('"Restore all" restores each record with a base', () => {
    const sim = world();
    const h = sim.look().history;
    const bodies = restoreAll(h, MG, [
      { kind: LIT, id: 'a' },
      { kind: LFO, id: 'f' },
    ]);
    expect(bodies.map((b) => [b.k, b.id, b.f['rm']])).toEqual([
      [LIT, 'a', 0],
      [LFO, 'f', 0],
    ]);
    expect(Object.keys(bodies[0]!.f['b'] as object)).toEqual([ED]);
  });
});
