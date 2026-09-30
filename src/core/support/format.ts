/**
 * Copy for the Support screen (#476). No money anywhere (owner rule): only
 * percentages, the supporter count and the goal lines. The app is
 * English-only; the website does its own EN/FR copy.
 */

/** "1 supporter" / "12 supporters". */
export function supportersLabel(count: number): string {
  return count === 1 ? '1 supporter' : `${count} supporters`;
}

/** "40% funded". */
export function percentFundedLabel(percent: number): string {
  return `${percent}% funded`;
}

/** "Keep the app up ✓ funded for 2026" (the year is left out when unknown). */
export function goalFundedLabel(label: string, year: number | null): string {
  return year === null ? `${label} ✓ funded` : `${label} ✓ funded for ${year}`;
}

/** The public support page, in the reader's language when it is French. */
export const SUPPORT_PAGE_URL = 'https://inukshuk.mvxtechnologies.com/support/';
export const SUPPORT_PAGE_URL_FR = 'https://inukshuk.mvxtechnologies.com/fr/support/';

export function supportPageUrl(locale: string | null | undefined): string {
  return typeof locale === 'string' && /^fr\b/i.test(locale)
    ? SUPPORT_PAGE_URL_FR
    : SUPPORT_PAGE_URL;
}
