import { LFO, LIT } from './kinds';
import { DEFAULT_LIBRARY_ROLE, detachedCopy, syncsInBackground } from './share';
import { LibSim, MIN, OWNER, ROOT, T0 } from './testUtils';
import { newFolder, newItem, trash } from './writes';

const at = (n: number) => T0 + n * MIN;

describe('background sync', () => {
  it('only teams sync in the background', () => {
    expect(syncsInBackground({ app: 'team', v: 1, follow: false, net: false })).toBe(true);
    expect(syncsInBackground({ app: 'lib', v: 1, follow: false, net: true })).toBe(false);
    expect(DEFAULT_LIBRARY_ROLE).toBe('member');
  });
});

describe('leave, keep a copy', () => {
  it('the tree as a normal folder: parents first, trash and sync fields left out', () => {
    const ED = 'ed'.padEnd(43, 'A');
    const sim = new LibSim({ [ED]: 'member' });
    sim.meta(at(0));
    sim.set(OWNER, at(0) + 1, newFolder(ROOT, 'Gaspésie'));
    sim.set(ED, at(1), newFolder('f', 'Day 1', ROOT));
    sim.set(ED, at(2), newItem('i', 'wpt', 'Camp', 'f', { ll: [-65, 49] }));
    sim.set(ED, at(3), newItem('j', 'wpt', 'Gone', ROOT));
    sim.set(ED, at(4), trash(sim.look().history, ED, LIT, 'j'));
    expect(detachedCopy(sim.look().view)).toEqual([
      { kind: LFO, id: ROOT, name: 'Gaspésie', fields: { n: 'Gaspésie' } },
      { kind: LFO, id: 'f', parent: ROOT, name: 'Day 1', fields: { n: 'Day 1', p: ROOT } },
      {
        kind: LIT,
        id: 'i',
        parent: 'f',
        name: 'Camp',
        fields: { t: 'wpt', n: 'Camp', p: 'f', ll: [-65, 49] },
      },
    ]);
  });

  it('a single shared item copies on its own', () => {
    const ED = 'ed'.padEnd(43, 'A');
    const sim = new LibSim({ [ED]: 'member' });
    sim.meta(at(0), 'solo');
    sim.set(ED, at(1), newItem('solo', 'trk', 'Ride', undefined, { g: '_p~iF~ps|U' }));
    expect(detachedCopy(sim.look().view)).toEqual([
      { kind: LIT, id: 'solo', name: 'Ride', fields: { t: 'trk', n: 'Ride', g: '_p~iF~ps|U' } },
    ]);
  });
});
