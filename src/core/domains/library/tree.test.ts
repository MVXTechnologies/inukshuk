import { emptyData, type TeamData } from '@core/team/data';
import { forAll, int, mulberry32, pick, shuffle } from '@core/team/testing/prop';

import { LFO, LIT, MAX_FOLDER_DEPTH } from './kinds';
import { canonicalView, LibSim, mid, MIN, OWNER, ROOT, T0 } from './testUtils';
import {
  checkMove,
  compareNodes,
  descendants,
  isWithin,
  libraryView,
  nodeOf,
  subtreeHeight,
  TOP,
  type LibraryView,
} from './tree';
import { newFolder, newItem, purge } from './writes';

const ED = mid('ed');
const E2 = mid('eb');
const MG = mid('mg');
const at = (n: number) => T0 + n * MIN;

function world() {
  const sim = new LibSim({ [ED]: 'member', [E2]: 'member', [MG]: 'admin' });
  sim.meta(at(0));
  sim.set(OWNER, at(0) + 1, newFolder(ROOT, 'Gaspésie 2026'));
  return sim;
}

/** Every folder reaches the top within the depth limit, through live folders. */
function assertSoundTree(v: LibraryView): void {
  for (const f of v.folders.values()) {
    let cur = f.parent;
    let steps = 0;
    while (cur !== TOP) {
      expect(v.folders.has(cur)).toBe(true);
      cur = v.folders.get(cur)!.parent;
      steps += 1;
      expect(steps).toBeLessThanOrEqual(MAX_FOLDER_DEPTH + 1);
    }
    expect(f.depth).toBeLessThanOrEqual(MAX_FOLDER_DEPTH);
    if (f.parent !== TOP) expect(f.depth).toBe(v.folders.get(f.parent)!.depth + 1);
  }
}

describe('library tree', () => {
  it('builds the tree with display order, folders first', () => {
    const sim = world();
    sim.set(ED, at(1), newFolder('f2', 'Zed', ROOT));
    sim.set(ED, at(2), newFolder('f1', 'Alpha', ROOT, { o: 5 }));
    sim.set(ED, at(3), newItem('i2', 'wpt', 'B', ROOT));
    sim.set(ED, at(4), newItem('i1', 'trk', 'B', ROOT));
    sim.set(ED, at(5), newItem('i3', 'wpt', 'A', 'f1'));
    sim.set(ED, at(6), newItem('i4', 'map', 'Ghost', 'nowhere', { cat: 'cpa-1' }));
    const { view } = sim.look();
    expect(view.root).toBe(ROOT);
    expect(view.folders.get(ROOT)!.depth).toBe(0);
    expect(view.children.get(TOP)!.map((n) => n.id)).toEqual([ROOT]);
    expect(view.children.get(ROOT)!.map((n) => n.id)).toEqual(['f1', 'f2', 'i1', 'i2', 'i4']);
    expect(view.children.get('f1')!.map((n) => n.id)).toEqual(['i3']);
    expect(view.items.get('i3')!.depth).toBe(2);
    // A dangling item parent goes under the root; the base never shows.
    expect(view.items.get('i4')!.parent).toBe(ROOT);
    expect(nodeOf(view, LIT, 'i1')!.fields).toEqual({ t: 'trk', n: 'B', p: ROOT });
    expect(nodeOf(view, LFO, 'f1')!.name).toBe('Alpha');
    expect(nodeOf(view, 'x', 'f1')).toBeUndefined();
    expect(compareNodes(view.items.get('i1')!, view.items.get('i1')!)).toBe(0);
  });

  it('a group without a root folder lists its nodes at the top', () => {
    const sim = new LibSim({ [ED]: 'member' });
    sim.meta(at(0), 'solo');
    sim.set(ED, at(1), newItem('solo', 'trk', 'Shared trail'));
    sim.set(ED, at(2), newFolder('f', 'Loose'));
    sim.set(ED, at(3), newFolder('g', 'Bad parent', 'nope'));
    const { view } = sim.look();
    expect(view.items.get('solo')!).toMatchObject({ parent: TOP, depth: 0 });
    expect(view.folders.get('f')!.depth).toBe(1);
    expect(view.repaired.get('g')).toBe('dangling');
    expect(libraryView(emptyData()).root).toBeUndefined();
  });

  it('A into B while B into A: the older move goes back under the root', () => {
    const sim = world();
    sim.set(ED, at(1), newFolder('a', 'A', ROOT));
    sim.set(ED, at(1) + 1, newFolder('b', 'B', ROOT));
    sim.syncAll(at(2));
    sim.set(ED, at(3), { k: LFO, id: 'a', f: { p: 'b' } });
    sim.set(E2, at(4), { k: LFO, id: 'b', f: { p: 'a' } });
    const { view } = sim.look();
    expect(view.folders.get('a')!.parent).toBe(ROOT);
    expect(view.folders.get('b')!.parent).toBe('a');
    expect(view.repaired.get('a')).toBe('cycle');
    assertSoundTree(view);
  });

  it('too deep: a folder sits beside its deepest allowed ancestor', () => {
    const sim = world();
    let parent = ROOT;
    for (let i = 1; i <= MAX_FOLDER_DEPTH + 2; i++) {
      sim.set(ED, at(i), newFolder(`d${i}`, `D${i}`, parent));
      parent = `d${i}`;
    }
    const { view } = sim.look();
    assertSoundTree(view);
    expect(view.folders.get(`d${MAX_FOLDER_DEPTH}`)!.depth).toBe(MAX_FOLDER_DEPTH);
    const deeper = view.folders.get(`d${MAX_FOLDER_DEPTH + 1}`)!;
    expect(deeper.depth).toBe(MAX_FOLDER_DEPTH);
    expect(deeper.parent).toBe(`d${MAX_FOLDER_DEPTH - 1}`);
    expect(view.repaired.get(`d${MAX_FOLDER_DEPTH + 1}`)).toBe('depth');
    expect(view.folders.get(`d${MAX_FOLDER_DEPTH + 2}`)!.depth).toBe(MAX_FOLDER_DEPTH);
  });

  it('trash: a trashed folder takes its contents; a purged one leaves them in the trash', () => {
    const sim = world();
    sim.set(ED, at(1), newFolder('f', 'F', ROOT));
    sim.set(ED, at(2), newFolder('g', 'G', 'f'));
    sim.set(ED, at(3), newItem('i', 'wpt', 'I', 'g'));
    sim.set(ED, at(4), { k: LFO, id: 'f', f: { rm: 1 } });
    let { view } = sim.look();
    expect(view.folders.get('f')).toMatchObject({ trashed: true, inTrash: true });
    expect(view.folders.get('f')!.trashedAt!.author).toBe(ED);
    expect(view.folders.get('g')).toMatchObject({ trashed: false, inTrash: true });
    expect(view.items.get('i')!.inTrash).toBe(true);
    expect(view.children.get(ROOT)).toBeUndefined();
    sim.del(MG, at(5), purge(LFO, 'f'));
    ({ view } = sim.look());
    expect(view.folders.has('f')).toBe(false);
    expect(view.folders.get('g')).toMatchObject({ parent: ROOT, inTrash: true });
    expect(view.items.get('i')!.inTrash).toBe(true);
    sim.del(MG, at(6), purge(LFO, 'g'));
    ({ view } = sim.look());
    expect(view.items.get('i')).toMatchObject({ parent: ROOT, inTrash: true });
  });

  it('checkMove refuses cycles, depth, the trash, the root and unknowns', () => {
    const sim = world();
    sim.set(ED, at(1), newFolder('a', 'A', ROOT));
    sim.set(ED, at(2), newFolder('b', 'B', 'a'));
    sim.set(ED, at(3), newFolder('t', 'T', ROOT));
    sim.set(ED, at(4), newItem('i', 'wpt', 'I', ROOT));
    let parent = ROOT;
    for (let i = 1; i <= MAX_FOLDER_DEPTH; i++) {
      sim.set(ED, at(10 + i), newFolder(`d${i}`, 'D', parent));
      parent = `d${i}`;
    }
    sim.set(ED, at(30), { k: LFO, id: 't', f: { rm: 1 } });
    const { view } = sim.look();
    expect(checkMove(view, LFO, 'a', 'b')).toBe('cycle');
    expect(checkMove(view, LFO, 'a', 'a')).toBe('cycle');
    expect(checkMove(view, LFO, 'b', 'a')).toBe('ok');
    expect(checkMove(view, LFO, 'a', `d${MAX_FOLDER_DEPTH - 1}`)).toBe('depth');
    expect(checkMove(view, LFO, 'b', `d${MAX_FOLDER_DEPTH - 1}`)).toBe('ok');
    expect(checkMove(view, LIT, 'i', `d${MAX_FOLDER_DEPTH}`)).toBe('ok');
    expect(checkMove(view, LIT, 'i', 't')).toBe('trash');
    expect(checkMove(view, LFO, ROOT, 'a')).toBe('root');
    expect(checkMove(view, LIT, 'nope', 'a')).toBe('missing');
    expect(checkMove(view, LIT, 'i', 'nope')).toBe('missing');
    expect(subtreeHeight(view, 'a')).toBe(1);
    expect(subtreeHeight(view, ROOT)).toBe(MAX_FOLDER_DEPTH);
    expect(isWithin(view, 'b', 'a')).toBe(true);
    expect(isWithin(view, 'a', 'b')).toBe(false);
    expect(descendants(view, 'a').map((n) => n.id)).toEqual(['b']);
  });
});

/** Random concurrent moves, creates, trashes and purges by several offline editors. */
function randomWorld(seed: number) {
  const rnd = mulberry32(seed);
  const authors = [ED, E2, MG];
  const sim = world();
  sim.syncAll(at(0) + 2);
  const folders = [ROOT];
  const items: string[] = [];
  let t = at(1);
  const steps = int(rnd, 5, 60);
  for (let s = 0; s < steps; s++) {
    t += int(rnd, 0, 3) * 1000;
    const a = pick(rnd, authors);
    const r = rnd();
    if (r < 0.2) {
      const id = `f${s}`;
      folders.push(id);
      sim.set(a, t, newFolder(id, `F${s}`, pick(rnd, folders)));
    } else if (r < 0.3) {
      const id = `i${s}`;
      items.push(id);
      sim.set(a, t, newItem(id, 'wpt', `I${s}`, pick(rnd, folders)));
    } else if (r < 0.65) {
      sim.set(a, t, { k: LFO, id: pick(rnd, folders), f: { p: pick(rnd, folders) } });
    } else if (r < 0.72 && items.length > 0) {
      sim.set(a, t, { k: LIT, id: pick(rnd, items), f: { p: pick(rnd, folders) } });
    } else if (r < 0.8) {
      sim.set(a, t, { k: LFO, id: pick(rnd, folders), f: { rm: rnd() < 0.7 ? 1 : 0 } });
    } else if (r < 0.84) {
      sim.del(MG, t, purge(LFO, pick(rnd, folders)));
    } else {
      sim.deliver(a, pick(rnd, authors), t);
    }
  }
  return { sim, rnd };
}

describe('property: the tree is sound and the same whatever the order', () => {
  it('no cycle and no folder too deep survives any op set (1,000 seeded cases)', () => {
    const repairs = new Map<string, number>();
    forAll(
      9712,
      1000,
      (rnd) => int(rnd, 0, 2 ** 31),
      (seed) => {
        const { sim } = randomWorld(seed);
        // Every phone's partial view, and the full one.
        for (const id of sim.phones.keys()) assertSoundTree(sim.look(id).view);
        const { view } = sim.look();
        assertSoundTree(view);
        for (const why of view.repaired.values()) repairs.set(why, (repairs.get(why) ?? 0) + 1);
      },
    );
    // The generator does build cycles and dangling parents (or the property proves nothing).
    expect(repairs.get('cycle')).toBeGreaterThan(50);
    expect(repairs.get('dangling')).toBeGreaterThan(0);
  });

  it('views do not depend on fold path or map order (300 cases)', () => {
    forAll(
      9713,
      300,
      (rnd) => int(rnd, 0, 2 ** 31),
      (seed) => {
        const { sim, rnd } = randomWorld(seed);
        const batch = sim.fold();
        const reference = canonicalView(libraryView(batch));
        expect(canonicalView(libraryView(sim.foldIncremental()))).toBe(reference);
        // The same records, inserted in another order (a restored fold cache).
        const shuffled: TeamData = {
          ...batch,
          entities: new Map(shuffle([...batch.entities.entries()], rnd)),
        };
        expect(canonicalView(libraryView(shuffled))).toBe(reference);
        // Phones that end up with the same ops agree.
        sim.syncAll(at(500));
        const views = [...sim.phones.keys()].map((id) => canonicalView(sim.look(id).view));
        expect(new Set(views).size).toBe(1);
        expect(views[0]).toBe(reference);
      },
    );
  });
});
