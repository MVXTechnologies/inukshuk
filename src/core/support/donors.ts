/**
 * Prominent donors (#476, round 2): people whose tips add up to at least
 * {@link DONOR_THRESHOLD_USD} may *choose* to appear by name in Settings ›
 * System info and on the website's support page.
 *
 * - The running total is kept on the device only, from the USD base price of
 *   each finished tip ({@link TIP_USD}), deduplicated by store transaction id.
 * - The offer appears once the total crosses the threshold, or right after a
 *   Patron tip (whose $99.99 base price sits a cent under it).
 * - A submission carries a display name, an optional place, the platform and
 *   the transaction ids the owner checks against the store reports before
 *   publishing anything. No email, no account, no device id.
 *
 * Pure: no React Native / Expo imports.
 */

import { isTipId, TIP_USD, type TipId } from './tips';

export const DONOR_THRESHOLD_USD = 100;
export const DONOR_NAME_MAX = 40;
export const DONOR_PLACE_MAX = 60;
/** Transaction ids kept (and sent) at most; also the Worker's limit. */
export const DONOR_MAX_TRANSACTIONS = 20;

/** What the device remembers about its own giving. */
export interface TipLedger {
  /** Sum of the USD base prices of every finished tip, in cents (no float drift). */
  totalCents: number;
  tipCount: number;
  /** Store transaction ids already counted, newest last (capped). */
  transactionIds: string[];
  /** A donor name was sent from this device (the offer is not shown again). */
  donorSubmitted: boolean;
}

export const EMPTY_LEDGER: TipLedger = {
  totalCents: 0,
  tipCount: 0,
  transactionIds: [],
  donorSubmitted: false,
};

/** How many ids are remembered for deduplication (well past any real use). */
const REMEMBERED_IDS = 200;

/**
 * Count one finished tip. A transaction already counted (the store can replay
 * one; the launch sweep can meet it again) changes nothing. Unknown products
 * are ignored.
 */
export function recordTip(
  ledger: TipLedger,
  tip: { productId: string; transactionId: string | null },
): TipLedger {
  if (!isTipId(tip.productId)) return ledger;
  const id = tip.transactionId;
  if (id !== null && ledger.transactionIds.includes(id)) return ledger;
  return {
    ...ledger,
    totalCents: ledger.totalCents + Math.round(TIP_USD[tip.productId] * 100),
    tipCount: ledger.tipCount + 1,
    transactionIds:
      id === null ? ledger.transactionIds : [...ledger.transactionIds, id].slice(-REMEMBERED_IDS),
  };
}

/** Validate a persisted ledger (junk and missing fields fall back to empty). */
export function sanitizeLedger(raw: unknown): TipLedger {
  if (typeof raw !== 'object' || raw === null) return EMPTY_LEDGER;
  const r = raw as Record<string, unknown>;
  const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
  return {
    totalCents: count(r.totalCents),
    tipCount: count(r.tipCount),
    transactionIds: Array.isArray(r.transactionIds)
      ? r.transactionIds.filter((x): x is string => typeof x === 'string').slice(-REMEMBERED_IDS)
      : [],
    donorSubmitted: r.donorSubmitted === true,
  };
}

/** Whether to offer "Add your name to the donors list". */
export function donorOfferVisible(ledger: TipLedger, lastTipId?: TipId | null): boolean {
  if (ledger.donorSubmitted) return false;
  return ledger.totalCents >= DONOR_THRESHOLD_USD * 100 || lastTipId === 'tip_patron';
}

export type DonorFormResult =
  { ok: true; name: string; place: string | null } | { ok: false; error: string };

/** Collapse whitespace and drop control characters. */
function clean(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function validateDonorForm(name: string, place: string): DonorFormResult {
  const n = clean(name);
  const p = clean(place);
  if (n === '') return { ok: false, error: 'Please enter the name to show.' };
  if (n.length > DONOR_NAME_MAX)
    return { ok: false, error: `The name can be at most ${DONOR_NAME_MAX} characters.` };
  if (p.length > DONOR_PLACE_MAX)
    return { ok: false, error: `The place can be at most ${DONOR_PLACE_MAX} characters.` };
  return { ok: true, name: n, place: p === '' ? null : p };
}

/** The JSON body of `POST /donors` on the tile Worker. */
export interface DonorSubmission {
  name: string;
  place: string | null;
  platform: 'ios' | 'android';
  transactionIds: string[];
}

export function donorSubmission(
  form: { name: string; place: string | null },
  platform: 'ios' | 'android',
  ledger: TipLedger,
): DonorSubmission {
  return {
    name: form.name,
    place: form.place,
    platform,
    transactionIds: ledger.transactionIds.slice(-DONOR_MAX_TRANSACTIONS),
  };
}

/** One published name, from `costs.json` → `donors`. */
export interface Donor {
  name: string;
  place: string | null;
  since: number | null;
}

/** "Anne T. · Rimouski · since 2026" style sub-line pieces. */
export function donorLine(donor: Donor): string {
  return [donor.place, donor.since === null ? null : `since ${donor.since}`]
    .filter((x): x is string => x !== null)
    .join(' · ');
}
