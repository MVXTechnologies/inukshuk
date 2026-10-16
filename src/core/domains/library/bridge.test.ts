import type { Json } from '@core/team/canonical';

import { fingerprint, reconcile, type Link, type LocalRecord, type PlannedWrite } from './bridge';
import { recordConflicts } from './history';
import { LFO, LIT } from './kinds';
import type { LocalKind } from './liveFields';
import { LibSim, mid, MIN, OWNER, T0 } from './testUtils';
import { edit, newFolder, newItem, trash } from './writes';

const ROOT = 'gasp';
const JU = mid('ju');
const at = (n: number) => T0 + n * MIN;

const WPT = (n: string, lng = -66.18): Record<string, Json> => ({ t: 'wpt', n, ll: [lng, 48.92] });

/** One phone: its Library (the share's scope) and its link table. */
class Phone {
  lib = new Map<string, LocalRecord>();
  links: Link[] = [];
  waiting: string[] = [];
  rootLocal: { kind: LocalKind; id: string } | undefined;
  private n = 0;
  constructor(
    readonly sim: LibSim,
    readonly id: string,
  ) {}

  put(kind: LocalKind, id: string, fields: Record<string, Json>, parent?: string) {
    const prev = this.lib.get(`${kind}:${id}`);
    const at = parent ?? prev?.parent;
    this.lib.set(`${kind}:${id}`, {
      kind,
      id,
      fields,
      ...(at !== undefined ? { parent: at } : {}),
    });
  }

  get(kind: LocalKind, id: string) {
    return this.lib.get(`${kind}:${id}`);
  }

  /** Reconcile, then carry out the plan: writes into the group, local ops into the Library. */
  run(now: number): { writes: PlannedWrite[]; local: number } {
    const { view, history } = this.sim.look(this.id);
    const rootLink = this.links.find((l) => l.rid === ROOT);
    const plan = reconcile({
      root: { kind: LFO, rid: ROOT },
      ...(this.rootLocal
        ? { rootLocal: this.rootLocal }
        : rootLink
          ? { rootLocal: { kind: rootLink.localKind, id: rootLink.local } }
          : {}),
      local: [...this.lib.values()],
      view,
      links: this.links,
      newLocalId: (rid) => `${this.id.slice(0, 2)}-${rid}`,
      newRecordId: (l) => l.id,
    });
    let t = now;
    for (const w of plan.writes) {
      t += 1;
      if (w.op === 'new')
        this.sim.set(
          this.id,
          t,
          w.kind === LFO
            ? newFolder(w.rid, w.fields['n'] as string, undefined, w.fields)
            : newItem(w.rid, w.fields['t'] as 'wpt', w.fields['n'] as string, undefined, w.fields),
        );
      else if (w.op === 'edit')
        this.sim.set(this.id, t, edit(history, this.id, w.kind, w.rid, w.fields));
      else this.sim.set(this.id, t, trash(history, this.id, w.kind, w.rid));
    }
    for (const op of plan.local) {
      if (op.op === 'delete') {
        this.lib.delete(`${op.kind}:${op.local}`);
        continue;
      }
      const { p: _p, ...fields } = op.fields;
      // The root folder of a joined share has no Library parent.
      const parent = op.parent === op.local ? undefined : op.parent;
      this.put(op.kind, op.local, fields, parent);
    }
    this.links = plan.links;
    this.waiting = plan.waiting;
    return { writes: plan.writes, local: plan.local.length };
  }
}

function world() {
  const sim = new LibSim({ [JU]: 'member' });
  sim.meta(at(0), ROOT);
  const me = new Phone(sim, OWNER);
  me.rootLocal = { kind: 'folder', id: ROOT };
  me.put('folder', ROOT, { n: 'Gaspésie 2026' });
  me.put('waypoint', 'w1', WPT('Refuge'));
  me.put('area', 'a1', { t: 'area', n: 'Bleuets', g: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' });
  const ju = new Phone(sim, JU);
  return { sim, me, ju };
}

describe('library bridge reconcile', () => {
  it('shares the folder, then plans nothing more (idempotent)', () => {
    const { me } = world();
    const first = me.run(at(1));
    expect(first.writes.map((w) => `${w.op} ${w.kind}:${w.rid}`).sort()).toEqual([
      'new lfo:gasp',
      'new lit:a1',
      'new lit:w1',
    ]);
    expect(me.run(at(2))).toEqual({ writes: [], local: 0 });
    expect(me.links.every((l) => l.seen === true)).toBe(true);
  });

  it('a joining phone builds the folder, and never echoes it back', () => {
    const { sim, me, ju } = world();
    me.run(at(1));
    sim.deliver(OWNER, JU, at(2));
    const got = ju.run(at(3));
    expect(got.writes).toEqual([]);
    expect(ju.get('folder', 'ju-gasp')?.fields).toEqual({ n: 'Gaspésie 2026' });
    expect(ju.get('waypoint', 'ju-w1')?.fields).toEqual(WPT('Refuge'));
    expect(ju.get('area', 'ju-a1')).toBeDefined();
    expect(ju.run(at(4))).toEqual({ writes: [], local: 0 });
  });

  it('carries renames both ways, writing only what changed here', () => {
    const { sim, me, ju } = world();
    me.run(at(1));
    sim.deliver(OWNER, JU, at(2));
    ju.run(at(3));
    ju.put('waypoint', 'ju-w1', { ...WPT('Refuge (fermé)'), d: 'Roof leaks' });
    const out = ju.run(at(4));
    expect(out.writes).toEqual([
      { op: 'edit', kind: LIT, rid: 'w1', fields: { n: 'Refuge (fermé)', d: 'Roof leaks' } },
    ]);
    sim.deliver(JU, OWNER, at(5));
    const back = me.run(at(6));
    expect(back.writes).toEqual([]);
    expect(me.get('waypoint', 'w1')?.fields).toEqual({ ...WPT('Refuge (fermé)'), d: 'Roof leaks' });
    // Clearing a description writes it empty.
    me.put('waypoint', 'w1', WPT('Refuge (fermé)'));
    expect(me.run(at(7)).writes).toEqual([{ op: 'edit', kind: LIT, rid: 'w1', fields: { d: '' } }]);
  });

  it('a delete here goes to the group trash, and leaves the other Library', () => {
    const { sim, me, ju } = world();
    me.run(at(1));
    sim.deliver(OWNER, JU, at(2));
    ju.run(at(3));
    me.lib.delete('waypoint:w1');
    expect(me.run(at(4)).writes).toEqual([{ op: 'trash', kind: LIT, rid: 'w1' }]);
    sim.deliver(OWNER, JU, at(5));
    ju.run(at(6));
    expect(ju.get('waypoint', 'ju-w1')).toBeUndefined();
    expect(me.run(at(7))).toEqual({ writes: [], local: 0 });
  });

  it('a restore in the group brings the item back', () => {
    const { sim, me, ju } = world();
    me.run(at(1));
    sim.deliver(OWNER, JU, at(2));
    ju.run(at(3));
    me.lib.delete('waypoint:w1');
    me.run(at(4));
    sim.deliver(OWNER, JU, at(5));
    ju.run(at(6));
    const { history } = sim.look(JU);
    sim.set(JU, at(7), edit(history, JU, LIT, 'w1', { rm: 0 }));
    sim.deliver(JU, OWNER, at(8));
    me.run(at(9));
    expect(me.get('waypoint', 'ow-w1')?.fields['n']).toBe('Refuge');
  });

  it('an item moved out of the folder leaves the share', () => {
    const { me } = world();
    me.run(at(1));
    me.lib.delete('area:a1');
    expect(me.run(at(2)).writes).toEqual([{ op: 'trash', kind: LIT, rid: 'a1' }]);
    expect(me.links.some((l) => l.rid === 'a1')).toBe(false);
  });

  it('two renames at once both go out; the group keeps one and lists the other', () => {
    const { sim, me, ju } = world();
    me.run(at(1));
    sim.deliver(OWNER, JU, at(2));
    ju.run(at(3));
    me.put('waypoint', 'w1', WPT('Refuge A'));
    ju.put('waypoint', 'ju-w1', WPT('Refuge B'));
    me.run(at(4));
    ju.run(at(5));
    sim.syncAll(at(6));
    me.run(at(7));
    ju.run(at(8));
    expect(me.get('waypoint', 'w1')?.fields['n']).toBe('Refuge B');
    expect(ju.get('waypoint', 'ju-w1')?.fields['n']).toBe('Refuge B');
    expect(recordConflicts(sim.look(OWNER).history, LIT, 'w1')).toHaveLength(1);
    expect(me.run(at(9))).toEqual({ writes: [], local: 0 });
  });

  it('waits for what it cannot hold, and links a catalog map once downloaded', () => {
    const { sim, me, ju } = world();
    me.put('map', 'm1', { t: 'map', n: 'Rivière du Berger', cat: 'cpa-berger' });
    me.put('map', 'm2', { t: 'map', n: 'Mont-Albert' });
    me.put('track', 't1', { t: 'trk', n: 'Too big' });
    me.run(at(1));
    sim.deliver(OWNER, JU, at(2));
    ju.run(at(3));
    expect(ju.waiting).toEqual(['m1', 'm2', 't1']);
    // The catalog download lands in the folder: linked, not shared a second time.
    ju.put('map', 'local-map', { t: 'map', n: 'Rivière du Berger', cat: 'cpa-berger' });
    expect(ju.run(at(4)).writes).toEqual([]);
    expect(ju.waiting).toEqual(['m2', 't1']);
    expect(ju.links.find((l) => l.rid === 'm1')?.local).toBe('local-map');
  });

  it('re-writes a create that never landed instead of deleting the item', () => {
    const { me } = world();
    const ghost: Link = {
      rid: 'w1',
      kind: LIT,
      local: 'w1',
      localKind: 'waypoint',
      base: { n: fingerprint('Refuge') },
    };
    me.links = [ghost];
    const out = me.run(at(1));
    expect(out.writes.some((w) => w.op === 'new' && w.rid === 'w1')).toBe(true);
    expect(me.get('waypoint', 'w1')).toBeDefined();
  });

  it('a trail without geometry waits; long values are fingerprinted short', () => {
    const { sim, me, ju } = world();
    me.run(at(1));
    sim.set(OWNER, at(2), newItem('boat', 'trk', 'x', ROOT, { t: 'trk' }));
    sim.deliver(OWNER, JU, at(3));
    ju.run(at(4));
    expect(ju.waiting).toContain('boat');
    expect(fingerprint('x'.repeat(100)).startsWith('#')).toBe(true);
    expect(fingerprint(undefined)).toBe('');
  });

  it('keeps sub-folders: nesting and moves between them travel both ways', () => {
    const { sim, me, ju } = world();
    me.put('folder', 'sub', { n: 'Jour 1' });
    me.put('folder', 'deep', { n: 'Matin' }, 'sub');
    me.put('waypoint', 'w9', WPT('Source'), 'deep');
    me.run(at(1));
    sim.deliver(OWNER, JU, at(2));
    ju.run(at(3));
    expect(ju.get('folder', 'ju-sub')?.parent).toBe('ju-gasp');
    expect(ju.get('folder', 'ju-deep')?.parent).toBe('ju-sub');
    expect(ju.get('waypoint', 'ju-w9')?.parent).toBe('ju-deep');
    expect(ju.get('waypoint', 'ju-w1')?.parent).toBe('ju-gasp');
    expect(ju.run(at(4))).toEqual({ writes: [], local: 0 });
    // Julie moves the source up one level; Marc's Library follows.
    ju.put('waypoint', 'ju-w9', WPT('Source'), 'ju-sub');
    expect(ju.run(at(5)).writes).toEqual([
      { op: 'edit', kind: LIT, rid: 'w9', fields: { p: 'sub' } },
    ]);
    sim.deliver(JU, OWNER, at(6));
    me.run(at(7));
    expect(me.get('waypoint', 'w9')?.parent).toBe('sub');
    // A new sub-folder on Julie's phone, with an item in it.
    ju.put('folder', 'jf', { n: 'Jour 2' }, 'ju-gasp');
    ju.put('area', 'ja', { t: 'area', n: 'Camp', g: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }, 'jf');
    ju.run(at(8));
    sim.deliver(JU, OWNER, at(9));
    me.run(at(10));
    expect(me.get('folder', 'ow-jf')?.parent).toBe('gasp');
    expect(me.get('area', 'ow-ja')?.parent).toBe('ow-jf');
    expect(me.run(at(11))).toEqual({ writes: [], local: 0 });
  });

  it('a change this phone cannot hold yet waits, base unmoved, until it can', () => {
    const { sim, me, ju } = world();
    me.run(at(1));
    sim.deliver(OWNER, JU, at(2));
    ju.run(at(3));
    sim.set(OWNER, at(4), edit(sim.look(OWNER).history, OWNER, LIT, 'w1', { n: 'Later' }));
    sim.deliver(OWNER, JU, at(5));
    const { view } = sim.look(JU);
    const plan = reconcile({
      root: { kind: LFO, rid: ROOT },
      rootLocal: { kind: 'folder', id: 'ju-gasp' },
      local: [...ju.lib.values()],
      view,
      links: ju.links,
      newLocalId: (rid) => rid,
      newRecordId: (l) => l.id,
      holdable: () => false,
    });
    expect(plan.local).toEqual([]);
    expect(plan.links.find((l) => l.rid === 'w1')!.base['n']).toBe(fingerprint('Refuge'));
    ju.run(at(6));
    expect(ju.get('waypoint', 'ju-w1')?.fields['n']).toBe('Later');
  });
});
