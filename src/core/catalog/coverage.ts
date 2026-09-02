/**
 * Coverage dedupe — one map per patch of ground, from the best source.
 *
 * Canada is published twice. NRCan's **CanTopo** GeoPDFs are the modern,
 * vector-derived 1:50k series, but they cover only part of the country;
 * **CanMatrix** is the scanned paper archive and covers all of it, Québec City
 * and the Arctic included. Ingesting both puts two rows in the store for every
 * sheet that has both, and the older scan is never the one a hiker wants.
 *
 * So a generator fragment may tag an item with:
 *
 * - `coverageKey` — a stable name for the *ground*, not the product, e.g.
 *   `"nts50k:021L14"`. Two items with the same key are the same map sheet from
 *   different publishers.
 * - `sourceRank` — how much this publisher's edition is preferred. Higher
 *   wins; CanTopo outranks CanMatrix.
 *
 * {@link dedupeByCoverage} then keeps, for each key, every item from the
 * best-ranked source and drops the rest. The build strips both fields before
 * publishing — this is a build-time decision, and nothing on a phone should
 * have to re-derive it.
 *
 * **Best source, not best item.** A few dozen NTS sheets were printed as two
 * half-sheets and CanMatrix publishes both (`canmatrix_013d04_e_tif.zip` and
 * `…_w_…`). They share the sheet's coverage key, because a CanTopo GeoPDF of
 * that sheet supersedes *both*; keeping only one item per key would silently
 * throw away half of every such map.
 *
 * Items with no `coverageKey` are always kept: a source that never opts in is
 * never silently thinned.
 */

/** The generator-side fields the dedupe reads. */
export interface CoverageCandidate {
  id: string;
  /** Stable identifier of the ground covered, e.g. "nts50k:021L14". */
  coverageKey?: string;
  /** Publisher preference for the same ground; higher wins. Default 0. */
  sourceRank?: number;
}

/** One item that lost a coverage contest, and to whom. */
export interface CoverageDrop {
  id: string;
  coverageKey: string;
  /** Id of an item kept for that key. */
  supersededBy: string;
}

export interface CoverageDedupeResult<T> {
  kept: T[];
  dropped: CoverageDrop[];
}

/**
 * Keep, for each `coverageKey`, every item at the highest `sourceRank` present
 * for that key, and drop the lower-ranked ones. Input order is preserved among
 * the winners; `dropped` names every loser and what superseded it, so the
 * build log can say exactly what the catalog thinned.
 */
export function dedupeByCoverage<T extends CoverageCandidate>(
  items: readonly T[],
): CoverageDedupeResult<T> {
  const bestRank = new Map<string, number>();
  for (const item of items) {
    const key = item.coverageKey;
    if (key === undefined || key === '') continue;
    const rank = item.sourceRank ?? 0;
    const held = bestRank.get(key);
    if (held === undefined || rank > held) bestRank.set(key, rank);
  }

  const kept: T[] = [];
  const dropped: CoverageDrop[] = [];
  // First winner seen per key, so a drop can name something concrete.
  const exemplar = new Map<string, string>();
  for (const item of items) {
    const key = item.coverageKey;
    if (key === undefined || key === '') {
      kept.push(item);
      continue;
    }
    if ((item.sourceRank ?? 0) === bestRank.get(key)) {
      if (!exemplar.has(key)) exemplar.set(key, item.id);
      kept.push(item);
    }
  }
  for (const item of items) {
    const key = item.coverageKey;
    if (key === undefined || key === '') continue;
    if ((item.sourceRank ?? 0) === bestRank.get(key)) continue;
    dropped.push({ id: item.id, coverageKey: key, supersededBy: exemplar.get(key) ?? '' });
  }
  return { kept, dropped };
}

/** The coverage key for a 1:50k NTS sheet id, e.g. "021L14" → "nts50k:021L14". */
export function ntsCoverageKey(sheetId: string): string {
  return `nts50k:${sheetId.toUpperCase()}`;
}

/**
 * Publisher ranks for the Canadian 1:50k sheets. Modern vector-derived GeoPDFs
 * beat archival scans of the same ground; the numbers are spaced so a future
 * source can slot between them.
 */
export const SOURCE_RANK_CANTOPO = 100;
export const SOURCE_RANK_CANMATRIX = 10;
