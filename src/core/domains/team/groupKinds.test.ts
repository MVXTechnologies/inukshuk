import { visibleFields } from '@core/team/crdt';
import { device, MIN, T0 } from '@core/team/testing/fixtures';
import { crew, why } from '@core/teamdraw/testUtils';
import { emptyData } from '@core/team/data';

import {
  authorizeTeamV27Kind,
  GREF,
  IRDV,
  isTeamV27Kind,
  MAX_GROUP_NAME,
  NET,
  ownedTeamV27Kind,
  TEAM_V27_KINDS,
  validTeamV27Write,
} from './groupKinds';

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

describe('irdv: an invite’s internet rendezvous', () => {
  it('admins write it (owned), with a 32-byte seed; members cannot', () => {
    const { w, rb, sync } = crew();
    const inv = device().id;
    const s = device().id; // 32 bytes, base64url
    const ok = w.root.write(at(1), 'e.set', { k: IRDV, id: inv, f: { s } })!;
    const member = rb.write(at(1), 'e.set', { k: IRDV, id: device().id, f: { s } })!;
    const short = w.root.write(at(2), 'e.set', { k: IRDV, id: device().id, f: { s: 'AAAA' } })!;
    const noSeed = w.root.write(at(3), 'e.set', { k: IRDV, id: device().id, f: { x: 1 } })!;
    const badId = w.root.write(at(4), 'e.set', { k: IRDV, id: 'inv1', f: { s } })!;
    sync(at(5));
    expect(why(rb, ok.id)).toBeUndefined();
    expect(why(rb, member.id)).toBe('forbidden');
    expect(why(rb, short.id)).toBe('invalid');
    expect(why(rb, noSeed.id)).toBe('invalid');
    expect(why(rb, badId.id)).toBe('invalid');
    expect(rb.data().entities.get(`irdv:${w.owner.id}:${inv}`)?.owner).toBe(w.owner.id);
    // A member cannot delete it; its writer can.
    const memberDel = rb.write(at(6), 'e.del', { k: IRDV, id: inv, o: w.owner.id })!;
    const ownDel = w.root.write(at(6), 'e.del', { k: IRDV, id: inv })!;
    sync(at(7));
    expect(why(rb, memberDel.id)).toBe('forbidden');
    expect(why(rb, ownDel.id)).toBeUndefined();
  });
});

describe('net: the team’s internet switch', () => {
  it('one shared record, admins only (writes and deletes); the first write carries inet', () => {
    const { w, rb, sync } = crew();
    const noInet = w.root.write(at(1), 'e.set', { k: NET, id: 'g', f: { later: 1 } })!;
    const on = w.root.write(at(2), 'e.set', { k: NET, id: 'g', f: { inet: 1 } })!;
    const member = rb.write(at(2), 'e.set', { k: NET, id: 'g', f: { inet: 0 } })!;
    const bad = w.root.write(at(3), 'e.set', { k: NET, id: 'g', f: { inet: 2 } })!;
    const wrongId = w.root.write(at(3), 'e.set', { k: NET, id: 'team', f: { inet: 1 } })!;
    sync(at(4));
    const memberDel = rb.write(at(5), 'e.del', { k: NET, id: 'g' })!;
    const delO = w.root.write(at(5), 'e.del', { k: NET, id: 'g', o: rb.id })!;
    sync(at(6));
    expect(why(w.root, noInet.id)).toBe('invalid');
    expect(why(w.root, on.id)).toBeUndefined();
    expect(why(w.root, member.id)).toBe('forbidden');
    expect(why(w.root, bad.id)).toBe('invalid');
    expect(why(w.root, wrongId.id)).toBe('invalid');
    expect(why(w.root, memberDel.id)).toBe('forbidden');
    expect(why(w.root, delO.id)).toBe('invalid');
    const rec = w.root.data().entities.get('net:g');
    expect(rec?.owner).toBeUndefined();
    expect(visibleFields(rec!.state)).toEqual({ inet: 1 });
    const adminDel = w.root.write(at(7), 'e.del', { k: NET, id: 'g' })!;
    expect(why(w.root, adminDel.id)).toBeUndefined();
    expect(w.root.data().entities.get('net:g')?.state.deleted).toBeDefined();
  });
});

describe('the 2.7.0 kind table', () => {
  it('names, ownership, and total guards for a kind it does not own', () => {
    expect(TEAM_V27_KINDS).toEqual([GREF, IRDV, NET]);
    expect(TEAM_V27_KINDS.map(isTeamV27Kind)).toEqual([true, true, true]);
    expect(isTeamV27Kind('wpt')).toBe(false);
    expect(TEAM_V27_KINDS.map(ownedTeamV27Kind)).toEqual([true, true, false]);
    expect(ownedTeamV27Kind('wpt')).toBe(false);
    const w = {
      op: 'set',
      kind: 'wpt',
      id: 'g',
      f: {},
      o: undefined,
      author: 'a',
      wall: 0,
    } as const;
    expect(validTeamV27Write(w)).toBe(false);
    expect(authorizeTeamV27Kind(w, 'owner', emptyData())).toBe('invalid');
  });
});
