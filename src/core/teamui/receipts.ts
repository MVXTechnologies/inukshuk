/**
 * Receipts for an SOS or a rally point (#708): "3 of 5 received". Pure.
 *
 * Each 2.6.1+ phone that syncs a teammate's SOS or rally point writes one
 * logged `e.set { k: 'rcp', id: <alert id>, f: { ak, ao } }` (validated by
 * the fold, `@core/team/records`). Phones before 2.6.1 never write one, so
 * the count is over the members that advertise the receipts capability
 * (`cap.rc`, `@core/teamdraw/caps`); with none of them, the raiser reads
 * "Sent" rather than a misleading "0 of 4".
 */
import type { Json } from '@core/team/canonical';
import { isLive, visibleFields } from '@core/team/crdt';
import { entityKey, type TeamData } from '@core/team/data';
import { hasCap, RECEIPT_CAP } from '@core/teamdraw/caps';

/** An alert a receipt can name: an SOS (`sos`) or a rally point (`rly`). */
export interface AlertRef {
  kind: 'sos' | 'rly';
  owner: string;
  id: string;
}

/** The body this phone writes to say it has `alert`. */
export function receiptBody(alert: AlertRef): { k: 'rcp'; id: string; f: Record<string, Json> } {
  return { k: 'rcp', id: alert.id, f: { ak: alert.kind, ao: alert.owner } };
}

/** Whether `member`'s receipt for `alert` is in the fold. */
export function hasReceipt(data: TeamData, member: string, alert: AlertRef): boolean {
  const rec = data.entities.get(entityKey('rcp', alert.id, member));
  if (rec === undefined || !isLive(rec.state)) return false;
  const f = visibleFields(rec.state);
  return f['ak'] === alert.kind && f['ao'] === alert.owner;
}

/**
 * Whether this phone still owes a receipt for `alert`: a teammate's alert
 * (never my own) without my receipt yet. The caller checks the alert is live.
 */
export function owesReceipt(data: TeamData, me: string, alert: AlertRef): boolean {
  return alert.owner !== me && !hasReceipt(data, me, alert);
}

export interface ReceiptCount {
  /** Members (not the alert's owner) whose receipt is in. */
  received: number;
  /** Members that can send one: they advertise `rc`, or already sent one. */
  capable: number;
  /** Every other active member. */
  others: number;
}

/** Who has received `alert`, among the active members (ids) other than its owner. */
export function receiptCount(
  data: TeamData,
  alert: AlertRef,
  activeMembers: readonly string[],
  now: number,
): ReceiptCount {
  let received = 0;
  let capable = 0;
  let others = 0;
  for (const m of activeMembers) {
    if (m === alert.owner) continue;
    others += 1;
    const got = hasReceipt(data, m, alert);
    if (got) received += 1;
    if (got || hasCap(data, m, now, RECEIPT_CAP)) capable += 1;
  }
  return { received, capable, others };
}

/** "3 of 5 received", or "Sent" when no other phone can say. */
export function receiptLine(c: ReceiptCount): string {
  if (c.capable === 0) return 'Sent';
  return `${c.received} of ${c.capable} received`;
}
