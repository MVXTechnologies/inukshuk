import { createTeam } from '@core/team/actions';
import type { Json } from '@core/team/canonical';
import { TeamReplica } from '@core/team/replica';
import { addMember, allEnvs, c, device, MIN, T0 } from '@core/team/testing/fixtures';
import { GMETA, GROUP_RECORD_ID } from '@core/group/meta';

import { libraryRegistry } from './index';
import { buildHistory, historyOps, recordConflicts } from './history';
import { LIT, MAX_INLINE_BODY, MAX_INLINE_GEOMETRY } from './kinds';
import { canonicalView, ROOT } from './testUtils';
import { libraryView } from './tree';
import { edit, fitsInline, newFolder, newItem } from './writes';

/**
 * The library plug-in on real signed, encrypted ops (`TeamReplica` with the
 * library registry): the base field passes the generic body checks, roles
 * come from the real membership, a full inline track fits the op cap, and
 * replicas converge.
 */
const at = (n: number) => T0 + n * MIN;

function libraryGroup() {
  const owner = device();
  const ed = device();
  const no = device();
  const vw = device();
  const lib = createTeam(c, owner.keys, at(0));
  const opts = { registry: libraryRegistry() };
  const ro = new TeamReplica(c, lib.teamId, owner.keys, lib.writer.cursor, opts);
  ro.addKey(lib.key);
  ro.ingest([lib.genesis.env], at(0));
  ro.write(at(1), 'e.set', { k: GMETA, id: GROUP_RECORD_ID, f: { app: 'lib', v: 1, root: ROOT } });
  ro.write(at(1) + 1, 'e.set', newFolder(ROOT, 'Gaspésie 2026') as unknown as Json);
  addMember(ro, ed, 'member', at(2));
  addMember(ro, no, 'member', at(2) + 1);
  addMember(ro, vw, 'guest', at(2) + 2);
  const join = (d: typeof ed) => {
    const r = new TeamReplica(c, lib.teamId, d.keys, undefined, opts);
    r.ingest(allEnvs(ro, at(3)), at(3));
    return r;
  };
  return { ro, ed, no, vw, re: join(ed), rn: join(no), rv: join(vw) };
}

const look = (r: TeamReplica) => {
  const data = r.data();
  return {
    view: libraryView(data),
    history: buildHistory(historyOps(r.state, data, (op) => r.decode(op))),
    data,
  };
};

const sync = (rs: TeamReplica[], now: number) => {
  for (let i = 0; i < 2; i++)
    for (const a of rs) for (const b of rs) if (a !== b) b.ingest(allEnvs(a, now), now);
};

describe('library group on real replicas', () => {
  it('editors write, viewers do not, a conflict surfaces the same on every phone', () => {
    const { ed, no, ro, re, rn, rv } = libraryGroup();
    const g = 'k'.repeat(MAX_INLINE_GEOMETRY - 8 * 1024);
    const trk = re.write(
      at(4),
      'e.set',
      newItem('t1', 'trk', 'Mont Ernest-Laforce', ROOT, { g }) as unknown as Json,
    );
    expect(trk).toBeDefined();
    const bad = rv.write(at(4), 'e.set', newItem('v1', 'wpt', 'nope', ROOT) as unknown as Json)!;
    sync([ro, re, rn, rv], at(5));
    expect(rv.data().skipped.find((s) => s.id === bad.id)?.why).toBe('forbidden');
    // Both rename the track offline, from the same base.
    re.write(at(6), 'e.set', edit(look(re).history, ed.id, LIT, 't1', { n: 'A' }) as never);
    rn.write(at(7), 'e.set', edit(look(rn).history, no.id, LIT, 't1', { n: 'B' }) as never);
    sync([ro, re, rn, rv], at(8));
    const views = [ro, re, rn, rv].map((r) => look(r));
    for (const l of views) {
      expect(canonicalView(l.view)).toBe(canonicalView(views[0]!.view));
      const [conflict] = recordConflicts(l.history, LIT, 't1');
      expect(conflict!.kept.value).toBe('B');
      expect(conflict!.others.map((o) => o.value)).toEqual(['A']);
    }
    expect(views[0]!.view.items.get('t1')!.fields['g']).toBe(g);
  });

  it('any body that fitsInline is accepted once encrypted, at the limit', () => {
    const { ro, re } = libraryGroup();
    const g = 'k'.repeat(MAX_INLINE_GEOMETRY);
    const base = newItem('t2', 'trk', 'Max', ROOT, { g });
    const pad = MAX_INLINE_BODY - new TextEncoder().encode(JSON.stringify(base)).length - 8;
    const body = newItem('t2', 'trk', 'Max', ROOT, { g, d: 'é'.repeat(Math.floor(pad / 2)) });
    expect(fitsInline(body)).toBe(true);
    expect(MAX_INLINE_BODY - new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThan(
      16,
    );
    const op = re.write(at(4), 'e.set', body as unknown as Json);
    expect(op).toBeDefined();
    expect(re.log.logged().some((x) => x.id === op!.id)).toBe(true);
    expect(fitsInline({ ...body, f: { ...body.f, x: 'x'.repeat(64) } })).toBe(false);
    expect(ro.data().skipped).toEqual([]);
  });
});
