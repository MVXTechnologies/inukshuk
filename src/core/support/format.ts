/**
 * Copy for the Support screen (#476): money, the progress line and the
 * "where the money goes" amounts. The app is English-only; the website does
 * its own EN/FR formatting inline.
 *
 * Deliberately not `Intl.NumberFormat`: Hermes' Intl differs between Android
 * and iOS builds and between OS versions, and these few strings must read the
 * same everywhere (and in Jest).
 */

import { annualAmount, type CostItem } from './costs';

const SYMBOLS: Readonly<Record<string, string>> = { USD: '$', CAD: '$', EUR: '€' };

function groupThousands(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * `$1,267`, `$14.50`; a currency with no symbol here reads `1,267 GBP`.
 * Whole amounts drop the cents: this is a ledger for people, not an invoice.
 */
export function formatMoney(amount: number, currency: string): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const cents = Math.round(abs * 100);
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  const digits =
    rest === 0
      ? groupThousands(whole)
      : `${groupThousands(whole)}.${String(rest).padStart(2, '0')}`;
  const symbol = SYMBOLS[currency];
  const body = symbol === undefined ? `${digits} ${currency}` : `${symbol}${digits}`;
  return negative ? `−${body}` : body;
}

/** The app's cost list shows each line per year; a one-off cost says so instead. */
export function annualCostLabel(item: CostItem, currency: string): string {
  if (item.period === 'once') return 'paid once';
  return formatMoney(annualAmount(item), currency);
}

/** "1 supporter so far" / "12 supporters so far". */
export function supportersLabel(count: number): string {
  return count === 1 ? '1 supporter so far' : `${count} supporters so far`;
}

/** "$0 of $1,267". */
export function raisedOfGoalLabel(raised: number, goal: number, currency: string): string {
  return `${formatMoney(raised, currency)} of ${formatMoney(goal, currency)}`;
}

/** The public accounts page, in the reader's language when it is French. */
export const SUPPORT_PAGE_URL = 'https://inukshuk.mvxtechnologies.com/support/';
export const SUPPORT_PAGE_URL_FR = 'https://inukshuk.mvxtechnologies.com/fr/support/';

export function supportPageUrl(locale: string | null | undefined): string {
  return typeof locale === 'string' && /^fr\b/i.test(locale)
    ? SUPPORT_PAGE_URL_FR
    : SUPPORT_PAGE_URL;
}
