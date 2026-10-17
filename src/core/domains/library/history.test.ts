import { visibleFields } from '@core/team/crdt';
import { recordKey } from '@core/group/registry';

import {
  activity,
  ACTIVITY_MS,
  buildHistory,
  recordBeaten,
  recordConflicts,
  recordMerges,
  reviews,
  seenUpTo,
  toReview,
} from './history';
import { LCM, LFO, LIT } from './kinds';
import { LibSim, mid, MIN, OWNER, ROOT, T0 } from './testUtils';
import {
  comment,
  edit,
  newFolder,
  newItem,
  purge,
  restore,
  restoreWithEdits,
  setCursor,
  trash,
  useVersion,
} from './writes';

const JU = mid('ju');
const NO = mid('no');
const MG = mid('mg');
const VW = mid('vw');
const at = (n: number) => T0 + n * MIN;

/** Julie and Noé (editors) both have the waypoint, then go offline. */
function world() {
  const sim = new LibSim({ [JU]: 'member', [NO]: 'member', [MG]: 'admin', [VW]: 'guest' });
  sim.meta(at(0));
  sim.set(OWNER, at(0) + 1, newFolder(ROOT, 'Gaspésie 2026'));
  sim.set(OWNER, at(1), newItem('bel', 'wpt', 'Belvédère', ROOT, { ic: 'view' }));
  sim.syncAll(at(2));
  return sim;
}

/** `who` edits from what its phone knows. */
const editOn = (sim: LibSim, who: string, now: number, f: Record<string, never> | object) =>
  sim.set(who, now, edit(sim.look(who).history, who, LIT, 'bel', f as never));

describe('conflicts through the fold', () => {
  it('two offline renames: later kept, the other one tap away, "Use this" resolves', () => {
    const sim = world();
    editOn(sim, JU, at(10), { n: 'Belvédère du lac' });
    editOn(sim, NO, at(5), { n: 'Lookout' });
    sim.syncAll(at(20));
    const { history, data } = sim.look(JU);
    const [c] = recordConflicts(history, LIT, 'bel');
    expect(c!.kept.value).toBe('Belvédère du lac');
    expect(c!.others.map((o) => [o.value, o.write.stamp.author])).toEqual([['Lookout', NO]]);
    expect(visibleFields(data.entities.get(recordKey(false, LIT, 'bel'))!.state)['n']).toBe(
      'Belvédère du lac',
    );
    expect(reviews(history).map((r) => r.id)).toEqual(['bel']);
    // Noé's version lost: it counts for him whatever his cursor says.
    expect(toReview(history, NO, at(100))).toBe(1);
    expect(toReview(history, JU, at(100))).toBe(0);
    expect(toReview(history, JU, 0)).toBe(1);
    sim.set(JU, at(21), useVersion(history, JU, LIT, 'bel', 'n', 'Lookout'));
    sim.syncAll(at(22));
    const after = sim.look(NO);
    expect(recordConflicts(after.history, LIT, 'bel')).toEqual([]);
    expect(reviews(after.history)).toEqual([]);
    expect(after.view.items.get('bel')!.name).toBe('Lookout');
  });

  it('edits of different fields merge silently, listed as such', () => {
    const sim = world();
    editOn(sim, NO, at(5), { ic: 'peak' });
    editOn(sim, JU, at(6), { d: 'View over the lake' });
    sim.syncAll(at(20));
    const { history, view } = sim.look();
    expect(recordConflicts(history, LIT, 'bel')).toEqual([]);
    expect(recordMerges(history, LIT, 'bel').map((m) => [m.write.stamp.author, m.fields])).toEqual([
      [JU, ['d']],
      [NO, ['ic']],
    ]);
    expect(view.items.get('bel')!.fields).toMatchObject({ ic: 'peak', d: 'View over the lake' });
    expect(recordMerges(history, LIT, 'nope')).toEqual([]);
    expect(recordConflicts(history, LIT, 'nope')).toEqual([]);
    expect(recordBeaten(history, LIT, 'nope')).toBeUndefined();
  });

  it('a delete that beat an offline edit: Restore brings it back with the edit', () => {
    const sim = world();
    editOn(sim, JU, at(5), { n: 'Belvédère (edited offline)' });
    sim.set(NO, at(6), trash(sim.look(NO).history, NO, LIT, 'bel'));
    sim.syncAll(at(10));
    const { history, view } = sim.look(JU);
    expect(view.items.get('bel')!.inTrash).toBe(true);
    const beaten = recordBeaten(history, LIT, 'bel')!;
    expect(beaten.removal.stamp.author).toBe(NO);
    expect(beaten.edits.map((e) => e.fields)).toEqual([{ n: 'Belvédère (edited offline)' }]);
    expect(toReview(history, JU, at(100))).toBe(1);
    // Someone renamed it meanwhile; the restore writes the beaten edit again.
    sim.set(MG, at(11), edit(history, MG, LIT, 'bel', { n: 'Other' }));
    sim.deliver(MG, JU, at(12));
    const h2 = sim.look(JU).history;
    sim.set(JU, at(13), restoreWithEdits(h2, JU, LIT, 'bel', beaten.edits));
    sim.syncAll(at(14));
    const after = sim.look(NO);
    expect(after.view.items.get('bel')).toMatchObject({
      inTrash: false,
      name: 'Belvédère (edited offline)',
    });
    expect(recordBeaten(after.history, LIT, 'bel')).toBeUndefined();
  });

  it('a plain restore keeps edits made while it was in the trash', () => {
    const sim = world();
    sim.set(NO, at(5), trash(sim.look(NO).history, NO, LIT, 'bel'));
    editOn(sim, JU, at(6), { d: 'offline note' });
    sim.syncAll(at(7));
    sim.set(NO, at(8), restore(sim.look(NO).history, NO, LIT, 'bel'));
    const { view } = sim.look(NO);
    expect(view.items.get('bel')).toMatchObject({ inTrash: false });
    expect(view.items.get('bel')!.fields['d']).toBe('offline note');
  });

  it('purged records leave the reviews', () => {
    const sim = world();
    editOn(sim, JU, at(5), { n: 'x' });
    sim.set(NO, at(6), trash(sim.look(NO).history, NO, LIT, 'bel'));
    sim.syncAll(at(7));
    expect(reviews(sim.look().history)).toHaveLength(1);
    sim.del(MG, at(8), purge(LIT, 'bel'));
    expect(reviews(sim.look().history)).toEqual([]);
  });
});

describe('activity', () => {
  it('one line per kept write, newest first, last 90 days, classified', () => {
    const sim = world();
    sim.set(JU, at(3), newFolder('f', 'Trips', ROOT));
    const h = () => sim.look().history;
    sim.set(JU, at(4), edit(h(), JU, LFO, 'f', { n: 'Trips 2026' }));
    sim.set(JU, at(5), edit(h(), JU, LIT, 'bel', { p: 'f' }));
    sim.set(NO, at(6), edit(h(), NO, LIT, 'bel', { d: 'x', ic: 'peak' }));
    sim.set(NO, at(7), trash(h(), NO, LIT, 'bel'));
    sim.set(NO, at(8), restore(h(), NO, LIT, 'bel'));
    sim.set(NO, at(9), trash(h(), NO, LFO, 'f'));
    sim.del(MG, at(10), purge(LFO, 'f'));
    // Refused writes never show.
    sim.set(VW, at(11), edit(h(), VW, LIT, 'bel', { n: 'viewer' }));
    const lines = activity(h(), at(12));
    expect(lines.map((l) => [l.action, l.kind, l.id])).toEqual([
      ['purge', LFO, 'f'],
      ['trash', LFO, 'f'],
      ['restore', LIT, 'bel'],
      ['trash', LIT, 'bel'],
      ['edit', LIT, 'bel'],
      ['move', LIT, 'bel'],
      ['rename', LFO, 'f'],
      ['create', LFO, 'f'],
      ['create', LIT, 'bel'],
      ['create', LFO, ROOT],
    ]);
    expect(lines[4]!.fields).toEqual(['d', 'ic']);
    expect(activity(h(), at(1) + ACTIVITY_MS + 1).map((l) => l.id)).not.toContain(ROOT);
  });
});

describe('comments and the cursor', () => {
  it('keeps live comments with their latest text; deletes drop them', () => {
    const sim = world();
    sim.set(VW, at(3), comment('c1', 'bel', 'Great view'));
    sim.set(VW, at(4), { k: LCM, id: 'c1', f: { tx: 'Great view at dawn' } });
    sim.set(JU, at(5), comment('c2', 'bel', 'Agreed'));
    sim.del(MG, at(6), { k: LCM, id: 'c2', o: JU });
    const { history } = sim.look();
    expect(history.comments.map((c) => [c.author, c.on, c.tx])).toEqual([
      [VW, 'bel', 'Great view at dawn'],
    ]);
  });

  it('seenUpTo reads my cursor (0 without one)', () => {
    const sim = world();
    expect(seenUpTo(sim.fold(), VW)).toBe(0);
    sim.set(VW, at(3), setCursor(at(2)));
    expect(seenUpTo(sim.fold(), VW)).toBe(at(2));
    expect(seenUpTo(sim.fold(), JU)).toBe(0);
  });

  it('buildHistory ignores other kinds and malformed bodies', () => {
    const h = buildHistory([
      { id: 'x1', stamp: { wall: T0, counter: 0, author: JU }, t: 'e.set', body: 'junk' },
      {
        id: 'x2',
        stamp: { wall: T0, counter: 1, author: JU },
        t: 'e.set',
        body: { k: 'gmeta', id: 'g', f: { app: 'lib' } },
      },
      {
        id: 'x3',
        stamp: { wall: T0, counter: 2, author: JU },
        t: 'e.set',
        body: { k: LCM, id: 'c', f: { tx: 'no target' } },
      },
      {
        id: 'x4',
        stamp: { wall: T0, counter: 3, author: JU },
        t: 'e.set',
        body: { k: LIT, id: 'i', f: { n: 'x', b: 'not a base' } },
      },
    ]);
    expect(h.comments).toEqual([]);
    expect(h.writes.map((w) => [w.id, w.base.size, w.fields])).toEqual([['x4', 0, { n: 'x' }]]);
  });
});
