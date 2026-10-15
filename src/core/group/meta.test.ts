import type { Json } from '@core/team/canonical';
import { visibleFields } from '@core/team/crdt';
import { device, MIN, T0 } from '@core/team/testing/fixtures';
import { crew, why } from '@core/teamdraw/testUtils';

import { DEFAULT_APP, GMETA, GMETA_KEY, GROUP_RECORD_ID, groupMeta, groupMetaPlugin } from './meta';

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

  it('the plug-in: one shared kind, no threads', () => {
    expect(groupMetaPlugin.kinds).toEqual([GMETA]);
    expect(groupMetaPlugin.owned(GMETA)).toBe(false);
    expect(groupMetaPlugin.threads).toBeUndefined();
  });
});
