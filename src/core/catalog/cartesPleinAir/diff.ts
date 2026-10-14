import type { CatalogItem } from '../schema';

/**
 * What changed between two crawls of a source (#680). The weekly job puts
 * this in its pull request, so a reviewer sees "3 added, 1 withdrawn, 2
 * republished" before anything reaches the catalog.
 *
 * - **added / removed**: by item id (the publisher's map id).
 * - **republished**: same map, different file `version` (the publisher
 *   replaced the PDF). Library copies then show "Update".
 * - **changed**: same file, other details changed (title, credit, location).
 */

export interface ItemChange {
  before: CatalogItem;
  after: CatalogItem;
  /** Fields that differ, e.g. ["title", "author"]. */
  fields: string[];
}

export interface CatalogDiff {
  added: CatalogItem[];
  removed: CatalogItem[];
  republished: ItemChange[];
  changed: ItemChange[];
  unchanged: number;
}

/** Fields a reviewer cares about; the order is the order they are reported in. */
const COMPARED: readonly (keyof CatalogItem)[] = [
  'title',
  'author',
  'year',
  'url',
  'pageUrl',
  'bbox',
  'bboxPrecision',
  'region',
  'sizeBytes',
  'updatedAt',
];

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function diffCatalogItems(
  before: readonly CatalogItem[],
  after: readonly CatalogItem[],
): CatalogDiff {
  const old = new Map(before.map((i) => [i.id, i]));
  const now = new Map(after.map((i) => [i.id, i]));
  const diff: CatalogDiff = { added: [], removed: [], republished: [], changed: [], unchanged: 0 };
  for (const item of after) {
    const prev = old.get(item.id);
    if (prev === undefined) {
      diff.added.push(item);
      continue;
    }
    const fields = COMPARED.filter((f) => !same(prev[f], item[f]));
    if (prev.version !== item.version) {
      diff.republished.push({ before: prev, after: item, fields: ['version', ...fields] });
    } else if (fields.length > 0) {
      diff.changed.push({ before: prev, after: item, fields });
    } else {
      diff.unchanged += 1;
    }
  }
  for (const item of before) if (!now.has(item.id)) diff.removed.push(item);
  const byTitle = (a: CatalogItem, b: CatalogItem) => a.title.localeCompare(b.title, 'fr');
  diff.added.sort(byTitle);
  diff.removed.sort(byTitle);
  diff.republished.sort((a, b) => byTitle(a.after, b.after));
  diff.changed.sort((a, b) => byTitle(a.after, b.after));
  return diff;
}

export function diffIsEmpty(diff: CatalogDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.republished.length === 0 &&
    diff.changed.length === 0
  );
}

/**
 * Refuse a crawl that would withdraw more than `maxFraction` of the previous
 * catalog in one go: that is a redesigned or half-served listing page, not
 * the publisher withdrawing a third of its maps overnight. Returns the reason
 * to refuse, or null when the crawl may be published.
 */
export function massRemovalGuard(
  previousCount: number,
  nextCount: number,
  removedCount: number,
  maxFraction = 0.2,
): string | null {
  if (nextCount === 0) return 'the crawl found no maps at all';
  if (previousCount === 0) return null;
  const fraction = removedCount / previousCount;
  return fraction > maxFraction
    ? `the crawl would withdraw ${removedCount} of ${previousCount} maps ` +
        `(${Math.round(fraction * 100)} %, limit ${Math.round(maxFraction * 100)} %)`
    : null;
}

function line(item: CatalogItem): string {
  const credit = [item.author, item.year].filter((p) => p !== undefined).join(', ');
  const link = item.pageUrl !== undefined ? ` — ${item.pageUrl}` : '';
  return `- ${item.title}${credit !== '' ? ` (${credit})` : ''}${link}`;
}

/** The pull request body's summary. */
export function diffSummaryMarkdown(diff: CatalogDiff, total: number): string {
  const head =
    `**${total} ${total === 1 ? 'map' : 'maps'}** · ${diff.added.length} added · ${diff.removed.length} withdrawn · ` +
    `${diff.republished.length} republished · ${diff.changed.length} details changed · ` +
    `${diff.unchanged} unchanged`;
  const section = (title: string, lines: string[]) =>
    lines.length === 0 ? '' : `\n\n### ${title}\n\n${lines.join('\n')}`;
  const change = (c: ItemChange) => `${line(c.after)} · ${c.fields.join(', ')}`;
  return (
    head +
    section('Added', diff.added.map(line)) +
    section('Withdrawn', diff.removed.map(line)) +
    section('Republished (new file)', diff.republished.map(change)) +
    section('Details changed', diff.changed.map(change))
  );
}
