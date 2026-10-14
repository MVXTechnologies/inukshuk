import type { CatalogItem, CatalogSource } from './schema';

/**
 * Credit lines for maps whose publisher's terms ask for them (#680).
 *
 * Cartes Plein-air lets us list its canoe maps on three conditions: we link
 * and never copy, we credit each map's own author(s), and we say the maps are
 * free on their site. The last two are UI text, and they live here so every
 * surface (Explore card, list row, detail page, Library row) says exactly the
 * same thing:
 *
 * - {@link itemCredit}: "Charles Leduc · 2023", the author as the publisher
 *   lists them. Never falls back to the source's name: a map whose author we
 *   do not know is not credited to anyone else.
 * - {@link freeAvailabilityLine}: "Available free at cartespleinair.org", or
 *   "Disponible gratuitement sur cartespleinair.org" on a French device (the
 *   wording the publisher recommended). The language is the device's
 *   (`deviceSearchLanguage`), the same rule place-name search uses.
 */

export type CreditLanguage = 'fr' | 'en';

/** "Charles Leduc · 2023", "Charles Leduc", or undefined when no author is known. */
export function itemCredit(item: Pick<CatalogItem, 'author' | 'year'>): string | undefined {
  const author = item.author?.trim();
  if (author === undefined || author === '') return undefined;
  return item.year !== undefined ? `${author} · ${item.year}` : author;
}

/** The "free at" line for a host, in the device's language. */
export function freeAvailabilityLine(host: string, lang: CreditLanguage): string {
  return lang === 'fr' ? `Disponible gratuitement sur ${host}` : `Available free at ${host}`;
}

/** The "free at" line a source's terms require, or undefined when they don't. */
export function sourceFreeLine(
  source: Pick<CatalogSource, 'freeAt'> | undefined,
  lang: CreditLanguage,
): string | undefined {
  return source?.freeAt !== undefined ? freeAvailabilityLine(source.freeAt, lang) : undefined;
}

/**
 * One line joining a credit and a "free at" host: "Charles Leduc · 2023 ·
 * Available free at cartespleinair.org". A downloaded map keeps both halves
 * (`MapDocument.sourceCredit` / `sourceFreeAt`), so its Library row still
 * names the author offline, in the device's current language. Undefined when
 * there is neither.
 */
export function creditLine(
  credit: string | undefined,
  freeAt: string | undefined,
  lang: CreditLanguage,
): string | undefined {
  const parts = [
    credit !== undefined && credit.trim() !== '' ? credit.trim() : undefined,
    freeAt !== undefined && freeAt !== '' ? freeAvailabilityLine(freeAt, lang) : undefined,
  ].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
