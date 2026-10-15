import type { Json } from '@core/team/canonical';
import { visibleFields } from '@core/team/crdt';
import { device, MIN, T0 } from '@core/team/testing/fixtures';
import { crew, why } from '@core/teamdraw/testUtils';

import {
  backdatesOnce,
  DEFAULT_APP,
  GMETA,
  GMETA_KEY,
  GROUP_RECORD_ID,
  groupMeta,
  groupPlugin,
  IRDV,
  NET,
} from './meta';
import type { KindWrite } from './registry';

const at = (n: number) => T0 + n * MIN;
const gmeta = (f: Record<string, Json>, id = GROUP_RECORD_ID) => ({ k: GMETA, id, f });
const parent = 'AAAAAAAAAAAAAAAAAAAAAA'; // 16 bytes, base64url

describe('gmeta: what a sync group is', () => {
  it('no record: a team (every group made before 2.7.0)', () => {
    const { w } = crew();
    expect(groupMeta(w.root.data())).toEqual({ app: DEFAULT_APP, v: 1, follow: false, net: false });
  });

  it('the owner (an admin) says what the group is; every replica reads it the same', () => {
    const { w, rb, sync } = crew();
    w.root.write(
      at(1),
      'e.set',
      gmeta({ app: 'lib', v: 1, parent, follow: 1, net: 0, root: 'f1' }),
    );
    sync(at(2));
    for (const r of [w.root, rb]) {
      expect(groupMeta(r.data())).toEqual({
        app: 'lib',
        v: 1,
        parent,
        follow: true,
        net: false,
        root: 'f1',
      });
    }
    expect(w.root.data().entities.get(GMETA_KEY)?.owner).toBeUndefined();
  });

  it('only admins write it; nobody deletes it', () => {
    const { w, rb, rg, sync } = crew();
    const byMember = rb.write(at(1), 'e.set', gmeta({ app: 'lib' }))!;
    const byGuest = rg.write(at(1), 'e.set', gmeta({ app: 'lib' }))!;
    w.root.write(at(2), 'e.set', gmeta({ app: 'team', net: 1 }));
    sync(at(3));
    const del = w.root.write(at(4), 'e.del', { k: GMETA, id: GROUP_RECORD_ID })!;
    expect(why(w.root, byMember.id)).toBe('forbidden');
    expect(why(w.root, byGuest.id)).toBe('forbidden');
    expect(why(w.root, del.id)).toBe('forbidden');
    expect(groupMeta(w.root.data())).toMatchObject({ app: 'team', net: true });
  });

  it('app, parent and root are written once: repeated, never changed; flags change freely', () => {
    const { w } = crew();
    const r = w.root;
    r.write(at(1), 'e.set', gmeta({ app: 'lib', parent, root: '*' }));
    const same = r.write(at(2), 'e.set', gmeta({ app: 'lib', follow: 1 }))!;
    const toTeam = r.write(at(3), 'e.set', gmeta({ app: 'team' }))!;
    const reparent = r.write(at(4), 'e.set', gmeta({ parent: 'BAAAAAAAAAAAAAAAAAAAAA' }))!;
    const reroot = r.write(at(5), 'e.set', gmeta({ root: 'f2' }))!;
    const flags = r.write(at(6), 'e.set', gmeta({ follow: 0, net: 1 }))!;
    expect(why(r, same.id)).toBeUndefined();
    expect(why(r, toTeam.id)).toBe('forbidden');
    expect(why(r, reparent.id)).toBe('forbidden');
    expect(why(r, reroot.id)).toBe('forbidden');
    expect(why(r, flags.id)).toBeUndefined();
    expect(groupMeta(r.data())).toEqual({
      app: 'lib',
      v: 1,
      parent,
      root: '*',
      follow: false,
      net: true,
    });
  });

  it('the first write names the app; malformed values and ids are invalid; unknown fields pass', () => {
    const { w } = crew();
    const r = w.root;
    const noApp = r.write(at(1), 'e.set', gmeta({ net: 1 }))!;
    const bad = [
      gmeta({ app: 'Lib' }),
      gmeta({ app: 'lib', v: 0 }),
      gmeta({ app: 'lib', v: 1.5 }),
      gmeta({ app: 'lib', v: 0x10000 }),
      gmeta({ app: 'lib', parent: 'short' }),
      gmeta({ app: 'lib', follow: 2 }),
      gmeta({ app: 'lib', net: true }),
      gmeta({ app: 'lib', root: 'a b' }),
    ].map((b, i) => r.write(at(2 + i), 'e.set', b)!);
    const wrongId = r.write(at(20), 'e.set', gmeta({ app: 'lib' }, 'x'))!;
    const withO = r.write(at(21), 'e.set', { ...gmeta({ app: 'lib' }), o: device().id })!;
    const later = r.write(at(22), 'e.set', gmeta({ app: 'lib', v: 3, colour: '#fff' }))!;
    expect(why(r, noApp.id)).toBe('invalid');
    for (const op of bad) expect(why(r, op.id)).toBe('invalid');
    expect(why(r, wrongId.id)).toBe('invalid');
    expect(why(r, withO.id)).toBe('invalid');
    expect(why(r, later.id)).toBeUndefined();
    const rec = r.data().entities.get(GMETA_KEY)!;
    expect(visibleFields(rec.state)['colour']).toBe('#fff');
    expect(groupMeta(r.data())).toMatchObject({ app: 'lib', v: 3 });
  });

  it('a write-once field stamped before the group existed is refused (bounded backdating)', () => {
    const { w } = crew();
    const born = w.root.state.genesis!.stamp.wall;
    const write = (wall: number, f: Record<string, Json>): KindWrite => ({
      op: 'set',
      kind: GMETA,
      id: GROUP_RECORD_ID,
      f,
      o: undefined,
      author: w.owner.id,
      wall,
    });
    const view = w.root.data();
    const auth = (wr: KindWrite) => groupPlugin.authorize(wr, 'owner', view, w.root.state);
    expect(backdatesOnce(write(born - 1, { app: 'lib' }), w.root.state)).toBe(true);
    expect(auth(write(born - 1, { app: 'lib' }))).toBe('forbidden');
    expect(auth(write(born - 1, { app: 'lib', parent }))).toBe('forbidden');
    // At or after the genesis: fine; flags alone are never time-bounded here.
    expect(auth(write(born, { app: 'lib' }))).toEqual({ owner: undefined });
    expect(backdatesOnce(write(born - 1, { net: 1 }), w.root.state)).toBe(false);
    // No genesis folded (cannot happen for an accepted op): fail closed.
    const noGenesis = { ...w.root.state, genesis: undefined };
    expect(backdatesOnce(write(born + 1, { app: 'lib' }), noGenesis)).toBe(true);
    // Through the fold, the earliest valid write wins and a later rival is refused.
    const first = w.root.write(at(1), 'e.set', gmeta({ app: 'lib' }))!;
    const rival = w.root.write(at(2), 'e.set', gmeta({ app: 'self' }))!;
    expect(why(w.root, first.id)).toBeUndefined();
    expect(why(w.root, rival.id)).toBe('forbidden');
  });

  it('the plug-in: gmeta, irdv, net; no threads', () => {
    expect(groupPlugin.kinds).toEqual([GMETA, IRDV, NET]);
    expect(groupPlugin.owned(GMETA)).toBe(false);
    expect(groupPlugin.owned(IRDV)).toBe(true);
    expect(groupPlugin.owned(NET)).toBe(false);
    expect(groupPlugin.threads).toBeUndefined();
  });
});

describe('irdv: an invite’s internet rendezvous (every group)', () => {
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

describe('net: the group’s internet switch', () => {
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
