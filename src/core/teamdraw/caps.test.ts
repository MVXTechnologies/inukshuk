import { T0, MIN } from '@core/team/testing/fixtures';

import { capBody, capHolders, capKey, hasCap, needsCap, PEN_CAP } from './caps';
import { crew } from './testUtils';

describe('capability records', () => {
  it('advertise pen once, and read back on every replica', () => {
    const { w, bob, eve, rb, sync } = crew();
    expect(needsCap(rb.data(), bob.id)).toBe(true);
    rb.write(T0 + MIN, 'e.set', capBody(bob.id));
    sync(T0 + 2 * MIN);
    expect(capKey(bob.id)).toBe(`cap:${bob.id}:${bob.id}`);
    expect(hasCap(w.root.data(), bob.id)).toBe(true);
    expect(hasCap(w.root.data(), bob.id, PEN_CAP)).toBe(true);
    expect(w.root.canReceive(bob.id, 'pen')).toBe(true);
    expect(needsCap(rb.data(), bob.id)).toBe(false);
    expect(hasCap(w.root.data(), eve.id)).toBe(false);
    expect(hasCap(w.root.data(), bob.id, 'other')).toBe(false);
  });

  it('a flag at 0, a deleted record, or a flag written before a delete: no capability', () => {
    const { w, bob, eve, rb, re, sync } = crew();
    re.write(T0 + MIN, 'e.set', { k: 'cap', id: eve.id, f: { pen: 0 } });
    rb.write(T0 + MIN, 'e.set', capBody(bob.id));
    rb.write(T0 + 2 * MIN, 'e.del', { k: 'cap', id: bob.id });
    sync(T0 + 3 * MIN);
    expect(hasCap(w.root.data(), eve.id)).toBe(false);
    expect(hasCap(w.root.data(), bob.id)).toBe(false);
    // Revived with only another flag: pen (written before the delete) stays off.
    rb.write(T0 + 4 * MIN, 'e.set', { k: 'cap', id: bob.id, f: { later: 1 } });
    sync(T0 + 5 * MIN);
    expect(hasCap(w.root.data(), bob.id, 'later')).toBe(true);
    expect(hasCap(w.root.data(), bob.id)).toBe(false);
    rb.write(T0 + 6 * MIN, 'e.set', capBody(bob.id));
    sync(T0 + 7 * MIN);
    expect(hasCap(w.root.data(), bob.id)).toBe(true);
  });

  it('capHolders: every member with the flag on, in one pass (Eve’s is off)', () => {
    const { w, bob, eve, rb, re, sync } = crew();
    re.write(T0 + MIN, 'e.set', { k: 'cap', id: eve.id, f: { pen: 0 } });
    rb.write(T0 + MIN, 'e.set', capBody(bob.id));
    rb.write(T0 + MIN + 1, 'e.set', { k: 'rly', id: 'r', f: { la: 46.8, lo: -71.2 } });
    sync(T0 + 2 * MIN);
    expect(capHolders(w.root.data())).toEqual(new Set([bob.id]));
    expect(capHolders(w.root.data(), 'other')).toEqual(new Set());
  });
});
