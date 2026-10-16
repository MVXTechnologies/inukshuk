import { visibleFields } from '@core/team/crdt';
import { MIN, T0 } from '@core/team/testing/fixtures';
import { crew, why } from '@core/teamdraw/testUtils';

import { GREF, MAX_GROUP_NAME, TEAM_V27, TEAM_V27_KINDS } from './groupKinds';

const at = (n: number) => T0 + n * MIN;
const child = 'AAAAAAAAAAAAAAAAAAAAAA';
const other = 'BAAAAAAAAAAAAAAAAAAAAA';

describe('gref: a child group announced in the team', () => {
  it('a member announces it (owned by them); every replica keys it under its writer', () => {
    const { w, bob, rb, sync } = crew();
    rb.write(at(1), 'e.set', { k: GREF, id: child, f: { app: 'lib', name: 'Winter maps' } });
    sync(at(2));
    const rec = w.root.data().entities.get(`gref:${bob.id}:${child}`);
    expect(rec?.owner).toBe(bob.id);
    expect(visibleFields(rec!.state)).toEqual({ app: 'lib', name: 'Winter maps' });
  });

  it('guests cannot; the first write names the app, which never changes; fields are checked', () => {
    const { rb, rg } = crew();
    const guest = rg.write(at(1), 'e.set', { k: GREF, id: child, f: { app: 'lib' } })!;
    const noApp = rb.write(at(1), 'e.set', { k: GREF, id: child, f: { name: 'x' } })!;
    rb.write(at(2), 'e.set', { k: GREF, id: child, f: { app: 'lib' } });
    const rename = rb.write(at(3), 'e.set', { k: GREF, id: child, f: { name: 'New' } })!;
    const reapp = rb.write(at(4), 'e.set', { k: GREF, id: child, f: { app: 'self' } })!;
    const long = rb.write(at(5), 'e.set', {
      k: GREF,
      id: other,
      f: { app: 'lib', name: 'x'.repeat(MAX_GROUP_NAME + 1) },
    })!;
    const badId = rb.write(at(6), 'e.set', { k: GREF, id: 'f1', f: { app: 'lib' } })!;
    const later = rb.write(at(7), 'e.set', { k: GREF, id: other, f: { app: 'lib', ic: 3 } })!;
    expect(why(rg, guest.id)).toBe('forbidden');
    expect(why(rb, noApp.id)).toBe('invalid');
    expect(why(rb, rename.id)).toBeUndefined();
    expect(why(rb, reapp.id)).toBe('forbidden');
    expect(why(rb, long.id)).toBe('invalid');
    expect(why(rb, badId.id)).toBe('invalid');
    expect(why(rb, later.id)).toBeUndefined();
  });

  it('deleted by its writer or an admin, nobody else; `o` only on a delete', () => {
    const { w, bob, rb, re, sync } = crew();
    rb.write(at(1), 'e.set', { k: GREF, id: child, f: { app: 'lib' } });
    rb.write(at(1) + 1, 'e.set', { k: GREF, id: other, f: { app: 'lib' } });
    sync(at(2));
    const setO = re.write(at(3), 'e.set', { k: GREF, id: child, o: bob.id, f: { name: 'x' } })!;
    const eveDel = re.write(at(3) + 1, 'e.del', { k: GREF, id: child, o: bob.id })!;
    const bobDel = rb.write(at(3), 'e.del', { k: GREF, id: child })!;
    const adminDel = w.root.write(at(3), 'e.del', { k: GREF, id: other, o: bob.id })!;
    sync(at(4));
    expect(why(w.root, setO.id)).toBe('invalid');
    expect(why(w.root, eveDel.id)).toBe('forbidden');
    expect(why(w.root, bobDel.id)).toBeUndefined();
    expect(why(w.root, adminDel.id)).toBeUndefined();
    const live = [...w.root.data().entities.values()].filter(
      (r) => r.kind === GREF && r.state.deleted === undefined,
    );
    expect(live).toEqual([]);
  });
});

describe('the team’s 2.7.0 kind table', () => {
  it('holds gref only (irdv and net are group-level)', () => {
    expect(TEAM_V27_KINDS).toEqual([GREF]);
    expect(TEAM_V27.has(GREF)).toBe(true);
    expect(TEAM_V27.has('irdv')).toBe(false);
    expect(TEAM_V27.owned(GREF)).toBe(true);
  });
});
