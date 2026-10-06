/**
 * Which cached rasters (tiles or blocks) to put on screen for the cells the
 * camera wants, within a texture budget.
 *
 * With blocks (`pdfDetailBlocks`) a raster can hold many cells, some of
 * them off screen after a pan, and several rasters can hold the same cell.
 * Two simple orders are tried and the better kept (more cells shown, then
 * fewer pixels):
 *
 * - by efficiency: the raster showing the most still-uncovered cells per
 *   pixel first;
 * - newest first: the rasters rendered most recently were planned for the
 *   current view, so they usually fit it best.
 *
 * Rasters already chosen count once, whatever cells they hold. Pure: the
 * hook passes its own `Detail`s.
 */
export interface RasterCandidate {
  pixels: number;
}

export interface RasterChoice<R extends RasterCandidate> {
  chosen: R[];
  /** Indices (into `holders`) of the cells the chosen rasters show. */
  covered: Set<number>;
  pixels: number;
}

/**
 * `holders[i]` are the rasters that can show cell i; `newestFirst` orders
 * every candidate by recency; `budget` caps the chosen rasters' pixels.
 */
export function chooseRasters<R extends RasterCandidate>(
  holders: readonly (readonly R[])[],
  newestFirst: readonly R[],
  budget: number,
): RasterChoice<R> {
  const byEfficiency = (): RasterChoice<R> => {
    const covered = new Set<number>();
    const chosen: R[] = [];
    let pixels = 0;
    for (;;) {
      const gain = new Map<R, number>();
      holders.forEach((list, i) => {
        if (covered.has(i)) return;
        for (const r of list) gain.set(r, (gain.get(r) ?? 0) + 1);
      });
      let best: R | null = null;
      let bestScore = 0;
      for (const [r, n] of gain) {
        if (pixels + r.pixels > budget) continue;
        const score = n / Math.max(1, r.pixels);
        if (score > bestScore) {
          best = r;
          bestScore = score;
        }
      }
      if (best === null) break;
      chosen.push(best);
      pixels += best.pixels;
      holders.forEach((list, i) => {
        if (list.includes(best)) covered.add(i);
      });
    }
    return { chosen, covered, pixels };
  };
  const byRecency = (): RasterChoice<R> => {
    const covered = new Set<number>();
    const chosen: R[] = [];
    let pixels = 0;
    for (const r of newestFirst) {
      if (pixels + r.pixels > budget) continue;
      let adds = false;
      holders.forEach((list, i) => {
        if (!covered.has(i) && list.includes(r)) adds = true;
      });
      if (!adds) continue;
      chosen.push(r);
      pixels += r.pixels;
      holders.forEach((list, i) => {
        if (list.includes(r)) covered.add(i);
      });
    }
    return { chosen, covered, pixels };
  };
  const a = byEfficiency();
  if (a.covered.size === holders.filter((l) => l.length > 0).length) return a;
  const b = byRecency();
  if (b.covered.size !== a.covered.size) return b.covered.size > a.covered.size ? b : a;
  return b.pixels < a.pixels ? b : a;
}
