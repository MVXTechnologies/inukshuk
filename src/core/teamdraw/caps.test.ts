import type { Json } from '@core/team/canonical';
import type { TeamData } from '@core/team/data';
import { T0, MIN } from '@core/team/testing/fixtures';

import {
  BLOB_CAP,
  CAP_RENEW_MS,
  CAP_SPECS,
  CAP_TTL_MS,
  capBody,
  capExpiry,
  capHolders,
  capKey,
  hasCap,
  LINK_CAP,
  needsCap,
  PEN_CAP,
  RTC_CAP,
} from './caps';
import { PEN_PROTOCOL, validCapFields } from './record';
import { crew } from './testUtils';

const DAY = 24 * 3600_000;

describe('capability records', () => {
  it('advertise pen, and read back on every replica', () => {
    const { w, bob, eve, rb, sync } = crew();
    const now = T0 + 2 * MIN;
    expect(needsCap(rb.data(), bob.id, now)).toBe(true);
    rb.write(T0 + MIN, 'e.set', capBody(bob.id, T0 + MIN));
    sync(now);
    expect(capKey(bob.id)).toBe(`cap:${bob.id}:${bob.id}`);
    expect(hasCap(w.root.data(), bob.id, now)).toBe(true);
    expect(hasCap(w.root.data(), bob.id, now, PEN_CAP)).toBe(true);
    expect(w.root.canReceive(bob.id, 'pen', now)).toBe(true);
    expect(needsCap(rb.data(), bob.id, now)).toBe(false);
    expect(hasCap(w.root.data(), eve.id, now)).toBe(false);
    expect(hasCap(w.root.data(), bob.id, now, 'other')).toBe(false);
  });

  it('a flag at 0, a deleted record, or a flag written before a delete: no capability', () => {
    const { w, bob, eve, rb, re, sync } = crew();
    const at = (n: number) => T0 + n * MIN;
    re.write(at(1), 'e.set', { k: 'cap', id: eve.id, f: { ...capBody(eve.id, at(1)).f, pen: 0 } });
    rb.write(at(1), 'e.set', capBody(bob.id, at(1)));
    rb.write(at(2), 'e.del', { k: 'cap', id: bob.id });
    sync(at(3));
    expect(hasCap(w.root.data(), eve.id, at(3))).toBe(false);
    expect(hasCap(w.root.data(), bob.id, at(3))).toBe(false);
    // Revived with only another flag: pen, v and x (written before the delete) stay off.
    rb.write(at(4), 'e.set', { k: 'cap', id: bob.id, f: { later: 1 } });
    sync(at(5));
    expect(hasCap(w.root.data(), bob.id, at(5))).toBe(false);
    rb.write(at(6), 'e.set', capBody(bob.id, at(6)));
    sync(at(7));
    expect(hasCap(w.root.data(), bob.id, at(7))).toBe(true);
  });

  it('capHolders: every member with a current claim, in one pass (Eve’s is off), until the first expiry', () => {
    const { w, bob, eve, rb, re, sync } = crew();
    re.write(T0 + MIN, 'e.set', { k: 'cap', id: eve.id, f: { ...capBody(eve.id, T0).f, pen: 0 } });
    rb.write(T0 + MIN, 'e.set', capBody(bob.id, T0 + MIN));
    rb.write(T0 + MIN + 1, 'e.set', { k: 'rly', id: 'r', f: { la: 46.8, lo: -71.2 } });
    sync(T0 + 2 * MIN);
    expect(capHolders(w.root.data(), T0 + 2 * MIN)).toEqual({
      holders: new Set([bob.id]),
      validUntil: T0 + MIN + CAP_TTL_MS,
    });
    expect(capHolders(w.root.data(), T0 + 2 * MIN, 'other').holders).toEqual(new Set());
  });

  it('a 2.5.2 integration claim without version or expiry ({ pen: 1 }) counts as absent', () => {
    const { w, bob, rb, sync } = crew();
    rb.write(T0 + MIN, 'e.set', { k: 'cap', id: bob.id, f: { pen: 1 } });
    sync(T0 + 2 * MIN);
    expect(hasCap(w.root.data(), bob.id, T0 + 2 * MIN)).toBe(false);
    expect(w.root.canReceive(bob.id, 'pen', T0 + 2 * MIN)).toBe(false);
    // Another pen protocol version: not one this phone speaks.
    rb.write(T0 + 3 * MIN, 'e.set', {
      k: 'cap',
      id: bob.id,
      f: { ...capBody(bob.id, T0).f, v: 2 },
    });
    sync(T0 + 4 * MIN);
    expect(hasCap(w.root.data(), bob.id, T0 + 4 * MIN)).toBe(false);
  });

  it('a claim expires (rolled back to 2.5.1 and never renewed), and cannot outlive the TTL', () => {
    const { w, bob, eve, rb, re, sync } = crew();
    rb.write(T0 + MIN, 'e.set', capBody(bob.id, T0 + MIN));
    // Eve writes an expiry a year out: capped at her stamp + the TTL.
    re.write(T0 + MIN, 'e.set', {
      k: 'cap',
      id: eve.id,
      f: { ...capBody(eve.id, T0).f, x: T0 + 365 * DAY },
    });
    sync(T0 + 2 * MIN);
    const r = w.root;
    expect(capExpiry(r.data(), bob.id)).toBe(T0 + MIN + CAP_TTL_MS);
    expect(capExpiry(r.data(), eve.id)).toBe(T0 + MIN + CAP_TTL_MS);
    expect(r.canReceive(bob.id, 'pen', T0 + MIN + CAP_TTL_MS - 1)).toBe(true);
    // No data change at all: the cached set lapses at the first expiry.
    expect(r.canReceive(bob.id, 'pen', T0 + MIN + CAP_TTL_MS)).toBe(false);
    expect(r.canReceive(eve.id, 'pen', T0 + MIN + CAP_TTL_MS)).toBe(false);
    expect(hasCap(r.data(), bob.id, T0 + 8 * DAY)).toBe(false);
  });

  it('renewed on a team open once it is over a day old', () => {
    const { bob, rb } = crew();
    rb.write(T0 + MIN, 'e.set', capBody(bob.id, T0 + MIN));
    expect(needsCap(rb.data(), bob.id, T0 + MIN + CAP_RENEW_MS - 1)).toBe(false);
    expect(needsCap(rb.data(), bob.id, T0 + MIN + CAP_RENEW_MS + 1)).toBe(true);
    rb.write(T0 + 2 * DAY, 'e.set', capBody(bob.id, T0 + 2 * DAY));
    expect(capExpiry(rb.data(), bob.id)).toBe(T0 + 2 * DAY + CAP_TTL_MS);
    expect(needsCap(rb.data(), bob.id, T0 + 2 * DAY)).toBe(false);
  });

  it('fields: non-negative safe integers only (flags, the version, the expiry)', () => {
    expect(validCapFields(capBody('m', T0).f)).toBe(true);
    expect(validCapFields({ pen: 1, later: 0 })).toBe(true);
    expect(validCapFields({ pen: -1 })).toBe(false);
    expect(validCapFields({ pen: 0.5 })).toBe(false);
    expect(validCapFields({ x: '1' })).toBe(false);
    expect(validCapFields({ x: null })).toBe(false);
  });
});

describe('a claim the fold would never let through', () => {
  it('an expiry that is not a number: no claim', () => {
    const stamp = { wall: T0, counter: 0, author: 'm' };
    const reg = (value: Json) => ({ value, stamp });
    const data = {
      entities: new Map([
        [
          capKey('m'),
          {
            kind: 'cap',
            id: 'm',
            owner: 'm',
            state: { fields: { pen: reg(1), v: reg(1), x: reg('soon') }, created: stamp },
          },
        ],
      ]),
    } as unknown as TeamData;
    expect(capExpiry(data, 'm')).toBeUndefined();
  });
});

describe('per-capability versions (2.7.0 sync groups)', () => {
  const at = (n: number) => T0 + n * MIN;

  it('every 2.7 capability holds only at a version this phone speaks, bound by its flag', () => {
    const { w, bob, eve, rb, re, sync } = crew();
    const x = at(1) + CAP_TTL_MS;
    // Bob: lnk v1, rtc v2 (a later protocol this phone does not speak), blob v1.
    rb.write(at(1), 'e.set', {
      k: 'cap',
      id: bob.id,
      f: { ...capBody(bob.id, at(1)).f, [LINK_CAP]: 1, [RTC_CAP]: 2, [BLOB_CAP]: 1 },
    });
    // Eve: no 2.7 flags at all.
    re.write(at(1), 'e.set', capBody(eve.id, at(1)));
    sync(at(2));
    const d = w.root.data();
    expect(capExpiry(d, bob.id, LINK_CAP)).toBe(x);
    expect(capExpiry(d, bob.id, BLOB_CAP)).toBe(x);
    expect(capExpiry(d, bob.id, RTC_CAP)).toBeUndefined();
    expect(capExpiry(d, eve.id, LINK_CAP)).toBeUndefined();
    expect(w.root.canReceive(bob.id, LINK_CAP, at(2))).toBe(true);
    expect(w.root.canReceive(eve.id, LINK_CAP, at(2))).toBe(false);
    expect(capHolders(d, at(2), LINK_CAP).holders).toEqual(new Set([bob.id]));
    // Rolled back: the old version renews pen/v/rc/x a day later, never lnk.
    rb.write(at(1) + DAY, 'e.set', capBody(bob.id, at(1) + DAY));
    sync(at(2) + DAY);
    expect(capExpiry(w.root.data(), bob.id, LINK_CAP)).toBe(x);
    expect(capExpiry(w.root.data(), bob.id)).toBe(at(1) + DAY + CAP_TTL_MS);
  });

  it('the pen claim keeps its 2.5.2 shape: flag 1 and the version in v, not bound by the flag', () => {
    const { w, bob, rb, sync } = crew();
    rb.write(at(1), 'e.set', {
      k: 'cap',
      id: bob.id,
      f: { ...capBody(bob.id, at(1)).f, pen: 2, v: PEN_PROTOCOL },
    });
    sync(at(2));
    expect(capExpiry(w.root.data(), bob.id)).toBeUndefined();
    rb.write(at(3), 'e.set', { k: 'cap', id: bob.id, f: { pen: 1, v: PEN_PROTOCOL + 1 } });
    sync(at(4));
    expect(capExpiry(w.root.data(), bob.id)).toBeUndefined();
    // The flag a day old, the expiry renewed eight days later: still held (2.5.2 rule).
    rb.write(at(5), 'e.set', { k: 'cap', id: bob.id, f: { v: PEN_PROTOCOL } });
    rb.write(at(5) + DAY, 'e.set', { k: 'cap', id: bob.id, f: { pen: 1 } });
    rb.write(at(5) + 9 * DAY, 'e.set', { k: 'cap', id: bob.id, f: { x: at(5) + 15 * DAY } });
    sync(at(6) + 9 * DAY);
    expect(capExpiry(w.root.data(), bob.id)).toBe(at(5) + 15 * DAY);
  });

  it('a capability this phone does not know is never held; a caller may pass its own spec', () => {
    const { w, bob, rb, sync } = crew();
    rb.write(at(1), 'e.set', { k: 'cap', id: bob.id, f: { ...capBody(bob.id, at(1)).f, zz: 3 } });
    sync(at(2));
    const d = w.root.data();
    expect(CAP_SPECS.has('zz')).toBe(false);
    expect(capExpiry(d, bob.id, 'zz')).toBeUndefined();
    expect(capExpiry(d, bob.id, 'zz', { versions: [3], boundByFlag: true })).toBe(
      at(1) + CAP_TTL_MS,
    );
    expect(capExpiry(d, bob.id, 'zz', { versions: [1, 2], boundByFlag: true })).toBeUndefined();
    expect(capExpiry(d, bob.id, 'absent', { versions: [1], boundByFlag: false })).toBeUndefined();
  });
});
