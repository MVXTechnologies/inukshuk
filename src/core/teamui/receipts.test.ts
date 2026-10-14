import { validReceiptFields } from '@core/team/records';
import { MIN, T0 } from '@core/team/testing/fixtures';
import {
  CAP_RENEW_MS,
  CAP_TTL_MS,
  capBody,
  capExpiry,
  hasCap,
  needsCap,
  PEN_CAP,
  RECEIPT_CAP,
} from '@core/teamdraw/caps';
import { crew, why } from '@core/teamdraw/testUtils';

import {
  hasReceipt,
  owesReceipt,
  receiptBody,
  receiptCount,
  receiptLine,
  type AlertRef,
} from './receipts';

const at = (n: number) => T0 + n * MIN;

describe('receipt records (#708)', () => {
  it('a member’s receipt for a teammate’s SOS is folded on every replica', () => {
    const { w, bob, eve, rb, re, sync } = crew();
    re.write(at(1), 'e.set', { k: 'sos', id: 's1', f: { la: 46.8, lo: -71.2 } });
    sync(at(2));
    const sos: AlertRef = { kind: 'sos', owner: eve.id, id: 's1' };
    expect(owesReceipt(rb.data(), bob.id, sos)).toBe(true);
    // Never for my own alert.
    expect(owesReceipt(re.data(), eve.id, sos)).toBe(false);
    rb.write(at(3), 'e.set', receiptBody(sos));
    sync(at(4));
    for (const r of [w.root, rb, re]) expect(hasReceipt(r.data(), bob.id, sos)).toBe(true);
    expect(owesReceipt(rb.data(), bob.id, sos)).toBe(false);
    // The same id under another owner, or another kind: not this alert.
    expect(hasReceipt(w.root.data(), bob.id, { ...sos, owner: w.owner.id })).toBe(false);
    expect(hasReceipt(w.root.data(), bob.id, { ...sos, kind: 'rly' })).toBe(false);
  });

  it('guests send receipts too; bad fields, a receipt for my own alert or one with o are invalid', () => {
    const { w, bob, gus, rb, rg, sync } = crew();
    const rly: AlertRef = { kind: 'rly', owner: bob.id, id: 'r1' };
    rb.write(at(1), 'e.set', { k: 'rly', id: 'r1', f: { la: 46.8, lo: -71.2 } });
    sync(at(2));
    rg.write(at(3), 'e.set', receiptBody(rly));
    const own = rb.write(at(3), 'e.set', receiptBody(rly))!;
    const extra = rg.write(at(4), 'e.set', {
      k: 'rcp',
      id: 'r2',
      f: { ak: 'rly', ao: bob.id, x: 1 },
    })!;
    const kind = rg.write(at(5), 'e.set', { k: 'rcp', id: 'r3', f: { ak: 'msg', ao: bob.id } })!;
    const forOther = rg.write(at(6), 'e.set', {
      k: 'rcp',
      id: 'r4',
      o: bob.id,
      f: { ak: 'rly', ao: bob.id },
    })!;
    sync(at(7));
    expect(hasReceipt(w.root.data(), gus.id, rly)).toBe(true);
    expect(why(w.root, own.id)).toBe('invalid');
    expect(why(w.root, extra.id)).toBe('invalid');
    expect(why(w.root, kind.id)).toBe('invalid');
    expect(why(w.root, forOther.id)).toBe('invalid');
    expect(validReceiptFields({ ak: 'sos' }, gus.id)).toBe(false);
    expect(validReceiptFields({ ak: 'sos', ao: 'not-a-member' }, gus.id)).toBe(false);
  });

  it('counts over the members advertising rc; "Sent" when none can say', () => {
    const { w, bob, eve, gus, rb, re, rg, sync } = crew();
    const sos: AlertRef = { kind: 'sos', owner: eve.id, id: 's1' };
    const active = [w.owner.id, bob.id, eve.id, gus.id];
    re.write(at(1), 'e.set', { k: 'sos', id: 's1', f: { la: 46.8, lo: -71.2 } });
    sync(at(2));
    // Nobody advertises yet (2.6.0 phones): "Sent".
    let c = receiptCount(re.data(), sos, active, at(2));
    expect(c).toEqual({ received: 0, capable: 0, others: 3 });
    expect(receiptLine(c)).toBe('Sent');
    // Bob and the guest are on 2.6.1; the owner's phone is older.
    rb.write(at(3), 'e.set', capBody(bob.id, at(3)));
    rg.write(at(3), 'e.set', capBody(gus.id, at(3)));
    rb.write(at(4), 'e.set', receiptBody(sos));
    sync(at(5));
    c = receiptCount(re.data(), sos, active, at(5));
    expect(c).toEqual({ received: 1, capable: 2, others: 3 });
    expect(receiptLine(c)).toBe('1 of 2 received');
    rg.write(at(6), 'e.set', receiptBody(sos));
    sync(at(7));
    expect(receiptLine(receiptCount(re.data(), sos, active, at(7)))).toBe('2 of 2 received');
    // A receipt from a phone without a current claim still counts (and is capable).
    w.root.write(at(8), 'e.set', receiptBody(sos));
    sync(at(9));
    expect(receiptCount(re.data(), sos, active, at(9))).toEqual({
      received: 3,
      capable: 3,
      others: 3,
    });
  });
});

describe('the receipts capability (rc)', () => {
  it('rides the pen claim; a 2.6.0 claim (no rc) needs renewing at once', () => {
    const { w, bob, rb, sync } = crew();
    const { rc: _rc, ...old } = capBody(bob.id, at(1)).f;
    rb.write(at(1), 'e.set', { k: 'cap', id: bob.id, f: old });
    sync(at(2));
    expect(hasCap(w.root.data(), bob.id, at(2), PEN_CAP)).toBe(true);
    expect(hasCap(w.root.data(), bob.id, at(2), RECEIPT_CAP)).toBe(false);
    expect(needsCap(rb.data(), bob.id, at(2))).toBe(true);
    rb.write(at(3), 'e.set', capBody(bob.id, at(3)));
    sync(at(4));
    expect(hasCap(w.root.data(), bob.id, at(4), RECEIPT_CAP)).toBe(true);
    expect(needsCap(rb.data(), bob.id, at(4))).toBe(false);
    // A day later the claim is renewed (both capabilities).
    expect(needsCap(rb.data(), bob.id, at(3) + CAP_RENEW_MS + 1)).toBe(true);
  });

  it('a phone rolled back to 2.6.0 keeps renewing pen; its old rc lapses a week after it was written', () => {
    const { w, bob, rb, sync } = crew();
    rb.write(at(1), 'e.set', capBody(bob.id, at(1)));
    sync(at(2));
    // 2.6.0 renews pen, v and x a few days later, never rc.
    const later = at(1) + 5 * 24 * 3600_000;
    const { rc: _rc, ...old } = capBody(bob.id, later).f;
    rb.write(later, 'e.set', { k: 'cap', id: bob.id, f: old });
    sync(later + 1);
    expect(capExpiry(w.root.data(), bob.id, PEN_CAP)).toBe(later + CAP_TTL_MS);
    expect(capExpiry(w.root.data(), bob.id, RECEIPT_CAP)).toBe(at(1) + CAP_TTL_MS);
    expect(hasCap(w.root.data(), bob.id, at(1) + CAP_TTL_MS, RECEIPT_CAP)).toBe(false);
    expect(hasCap(w.root.data(), bob.id, at(1) + CAP_TTL_MS, PEN_CAP)).toBe(true);
  });

  it('another receipt protocol version is not one this phone counts', () => {
    const { w, bob, rb, sync } = crew();
    rb.write(at(1), 'e.set', { k: 'cap', id: bob.id, f: { ...capBody(bob.id, at(1)).f, rc: 2 } });
    sync(at(2));
    expect(hasCap(w.root.data(), bob.id, at(2), RECEIPT_CAP)).toBe(false);
    expect(hasCap(w.root.data(), bob.id, at(2), PEN_CAP)).toBe(true);
  });
});
