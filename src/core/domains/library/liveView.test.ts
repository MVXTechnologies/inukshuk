import { LIT } from './kinds';
import {
  activityFeed,
  agoPhrase,
  peopleRows,
  peopleSummary,
  roleLabel,
  rowNote,
  syncLine,
} from './liveView';
import { LibSim, mid, MIN, OWNER, T0 } from './testUtils';
import { edit, newFolder, newItem, trash } from './writes';

const JU = mid('ju');
const NO = mid('no');
const at = (n: number) => T0 + n * MIN;
const NAMES: Record<string, string> = { [OWNER]: 'Marc', [JU]: 'Julie', [NO]: 'Noé' };
const name = (id: string) => NAMES[id] ?? 'Someone';

function world() {
  const sim = new LibSim({ [JU]: 'member', [NO]: 'member' });
  sim.meta(at(0), 'gasp');
  sim.set(OWNER, at(1), newFolder('gasp', 'Gaspésie 2026'));
  sim.set(OWNER, at(2), newItem('w1', 'wpt', 'Refuge', 'gasp', { ll: [-66.18, 48.92] }));
  sim.set(OWNER, at(3), newItem('w2', 'wpt', 'Belvédère', 'gasp', { ll: [-66.1, 48.9] }));
  sim.syncAll(at(4));
  return sim;
}

describe('liveView', () => {
  it('words ages and the sync line', () => {
    expect(agoPhrase(10_000)).toBe('just now');
    expect(agoPhrase(2 * MIN)).toBe('2 min ago');
    expect(agoPhrase(5 * 60 * MIN)).toBe('5 h ago');
    expect(agoPhrase(30 * 60 * MIN)).toBe('yesterday');
    expect(agoPhrase(3 * 24 * 60 * MIN)).toBe('3 days ago');
    expect(syncLine({ joining: { from: 'Julie' }, waiting: 0, now: 0 })).toEqual({
      text: 'Joining · from Julie',
      tone: 'join',
    });
    expect(syncLine({ waiting: 2, now: 0 })).toEqual({ text: '2 changes waiting', tone: 'wait' });
    expect(syncLine({ waiting: 1, now: 0 }).text).toBe('1 change waiting');
    expect(syncLine({ waiting: 0, lastSyncAt: 0, now: 2 * MIN })).toEqual({
      text: 'Synced 2 min ago',
      tone: 'ok',
    });
    expect(syncLine({ waiting: 0, now: 0 }).text).toBe('Live');
  });

  it('notes who changed a row last, and two versions of one field', () => {
    const sim = world();
    const h0 = sim.look(JU).history;
    expect(rowNote(h0, LIT, 'w1', OWNER, name, at(5))).toBeUndefined();
    expect(rowNote(h0, LIT, 'w1', JU, name, at(5))).toEqual({
      text: 'Added by Marc · 3 min',
      conflict: false,
    });
    sim.set(JU, at(10), edit(h0, JU, LIT, 'w1', { n: 'Refuge A' }));
    sim.set(NO, at(11), edit(sim.look(NO).history, NO, LIT, 'w1', { n: 'Refuge B' }));
    sim.syncAll(at(12));
    const h = sim.look(OWNER).history;
    expect(rowNote(h, LIT, 'w1', OWNER, name, at(12))).toEqual({
      text: '2 versions · Noé, Julie',
      conflict: true,
    });
    sim.set(OWNER, at(13), edit(h, OWNER, LIT, 'w2', { n: 'Belvédère du lac' }));
    expect(rowNote(sim.look(OWNER).history, LIT, 'w2', JU, name, at(73))).toEqual({
      text: 'Renamed by Marc · 1 h',
      conflict: false,
    });
  });

  it('pins conflicts and beaten edits on top, then the changes by day', () => {
    const sim = world();
    sim.set(JU, at(10), edit(sim.look(JU).history, JU, LIT, 'w1', { n: 'Refuge A' }));
    sim.set(NO, at(11), edit(sim.look(NO).history, NO, LIT, 'w1', { n: 'Refuge B' }));
    // Noé deletes w2 while Marc, offline, edits it.
    sim.set(NO, at(12), trash(sim.look(NO).history, NO, LIT, 'w2'));
    sim.set(OWNER, at(13), edit(sim.look(OWNER).history, OWNER, LIT, 'w2', { d: 'View' }));
    sim.syncAll(at(14));
    const { view, history } = sim.look(OWNER);
    const feed = activityFeed(history, view, OWNER, name, at(15));
    const text = (l: { parts: { t: string }[] }) => l.parts.map((p) => p.t).join('');
    expect(feed.pinned.map(text).sort()).toEqual([
      'Noé and Julie both renamed Refuge B',
      'Noé deleted Belvédère while you were editing it',
    ]);
    expect(feed.pinned.map((l) => l.review?.action).sort()).toEqual(['restore', 'review']);
    const lines = feed.days.flatMap((d) => d.lines).map(text);
    expect(lines[lines.length - 1]).toBe('You shared this folder');
    expect(lines).toContain('Noé deleted Belvédère');
    expect(lines).toContain('Julie renamed Refuge B');
    expect(feed.people.sort()).toEqual([JU, NO].sort());
    // Filtered by one person.
    const julie = activityFeed(history, view, OWNER, name, at(15), JU);
    expect(julie.days.flatMap((d) => d.lines).every((l) => l.author === JU)).toBe(true);
    expect(julie.pinned).toEqual([]);
  });

  it('lists people: me first, then by role', () => {
    const rows = peopleRows(
      [
        { id: JU, role: 'member', status: 'active' },
        { id: OWNER, role: 'owner', status: 'active' },
        { id: NO, role: 'guest', status: 'active' },
        { id: mid('gone'), role: 'member', status: 'removed' },
      ],
      OWNER,
      name,
    );
    expect(rows.map((r) => [r.name, r.detail])).toEqual([
      ['You', 'Owner'],
      ['Julie', 'Can edit'],
      ['Noé', 'Can view'],
    ]);
    expect(peopleSummary(rows)).toBe('2 can edit · 1 can view');
    expect(peopleSummary(rows.slice(0, 2))).toBe('2 can edit');
    expect(roleLabel('admin')).toBe('Manager');
    expect(peopleRows([], OWNER, name)).toEqual([]);
  });
});
