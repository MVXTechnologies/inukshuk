import { CURSOR_ID, LNX, LPT } from './kinds';
import { assembleTrack, hasPart, partBodies } from './parts';
import { gid, LibSim, mid, MIN, T0 } from './testUtils';
import { PART_CHARS } from './trackCodec';

const ED = mid('ed');
const VW = mid('vw');
const MG = mid('mg');
const at = (n: number) => T0 + n * MIN;

function world() {
  const sim = new LibSim({ [ED]: 'member', [VW]: 'guest', [MG]: 'admin' });
  sim.meta(at(0), 'gasp');
  return sim;
}

describe('trail parts', () => {
  it('splits a trail into ordered parts and reassembles it once all are in', () => {
    const sim = world();
    const encoded = 'A' + '?'.repeat(PART_CHARS * 2 + 10);
    const bodies = partBodies('t1', 'rev1', encoded);
    expect(bodies.map((b) => b.f['n'])).toEqual([0, 1, 2]);
    expect(bodies.every((b) => b.f['of'] === 3 && b.f['i'] === 't1')).toBe(true);
    sim.set(ED, at(1), bodies[2]!);
    sim.set(ED, at(2), bodies[0]!);
    expect(assembleTrack(sim.fold(), 't1', 'rev1', 3)).toBeUndefined();
    expect(hasPart(sim.fold(), 'rev1', 0)).toBe(true);
    expect(hasPart(sim.fold(), 'rev1', 1)).toBe(false);
    sim.set(ED, at(3), bodies[1]!);
    expect(assembleTrack(sim.fold(), 't1', 'rev1', 3)).toBe(encoded);
    // A revision cannot be borrowed by another item, nor read with another count.
    expect(assembleTrack(sim.fold(), 't2', 'rev1', 3)).toBeUndefined();
    expect(assembleTrack(sim.fold(), 't1', 'rev1', 2)).toBeUndefined();
  });

  it('parts are an editor’s, written once, complete; a manager purges', () => {
    const sim = world();
    const [part] = partBodies('t1', 'rev1', 'A???');
    expect(sim.why(sim.set(VW, at(1), part!).id)).toBe('forbidden');
    expect(sim.why(sim.set(ED, at(2), { k: LPT, id: 'x_0', f: { i: 't1' } }).id)).toBe('invalid');
    expect(
      sim.why(sim.set(ED, at(3), { k: LPT, id: 'y_0', f: { ...part!.f, n: 1, of: 1 } }).id),
    ).toBe('invalid');
    expect(sim.why(sim.set(ED, at(4), part!).id)).toBeUndefined();
    expect(sim.why(sim.set(ED, at(5), { ...part!, f: { ...part!.f, d: 'A?@' } }).id)).toBe(
      'forbidden',
    );
    expect(sim.why(sim.del(ED, at(6), { k: LPT, id: part!.id }).id)).toBe('forbidden');
    expect(sim.why(sim.del(MG, at(7), { k: LPT, id: part!.id }).id)).toBeUndefined();
    expect(sim.why(sim.set(ED, at(8), part!).id)).toBe('forbidden');
  });

  it('capability claims: one per member, its own; lnx: a manager’s, never deleted', () => {
    const sim = world();
    const mine = { k: 'cap', id: ED, f: { pen: 1, v: 1, lnk: 1, rtc: 1 } };
    expect(sim.why(sim.set(ED, at(1), mine).id)).toBeUndefined();
    expect(sim.why(sim.set(ED, at(2), { ...mine, id: MG }).id)).toBe('invalid');
    expect(sim.why(sim.set(ED, at(3), { ...mine, f: { lnk: 'x' } }).id)).toBe('invalid');
    expect(sim.why(sim.set(VW, at(4), { ...mine, id: VW }).id)).toBeUndefined();
    expect(sim.why(sim.set(MG, at(5), { k: LNX, id: 'other', f: { g: gid('n') } }).id)).toBe(
      'forbidden',
    );
    expect(sim.why(sim.set(MG, at(6), { k: LNX, id: CURSOR_ID, f: { g: 'nope' } }).id)).toBe(
      'invalid',
    );
  });
});
