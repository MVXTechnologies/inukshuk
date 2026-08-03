/**
 * Cuts one trail's point sequence into alternating cold/hot runs from the
 * per-point cell keys and a same-category cell count. Adjacent runs share
 * their boundary point index so the rendered LineStrings connect without
 * gaps; `count` is 1 for cold runs and the max count along the run when hot.
 */
export interface HeatRun {
  startIdx: number;
  endIdx: number;
  count: number;
}

export function splitHeatRuns(
  perPoint: readonly string[],
  countAt: (key: string) => number,
): HeatRun[] {
  if (perPoint.length < 2) return [];
  const runs: HeatRun[] = [];
  let start = 0;
  let count = 0;
  let hot = false;

  const countOf = (i: number): number => {
    const key = perPoint[i];
    return key === undefined ? 1 : Math.max(1, countAt(key));
  };

  for (let i = 0; i < perPoint.length; i++) {
    const c = countOf(i);
    const isHot = c >= 2;
    if (i === 0) {
      hot = isHot;
      count = c;
      continue;
    }
    if (isHot === hot) {
      if (isHot) count = Math.max(count, c);
      continue;
    }
    // Transition: close the current run at this point (shared boundary).
    runs.push({ startIdx: start, endIdx: i, count: hot ? count : 1 });
    start = i;
    hot = isHot;
    count = c;
  }
  runs.push({ startIdx: start, endIdx: perPoint.length - 1, count: hot ? count : 1 });
  // A trailing run of a single point (when a transition lands exactly on the
  // last index) cannot form a LineString — merge it backward into its predecessor.
  const last = runs[runs.length - 1];
  const penultimate = runs[runs.length - 2];
  if (last && penultimate && last.startIdx === last.endIdx) {
    runs.splice(-2, 2, {
      startIdx: penultimate.startIdx,
      endIdx: last.endIdx,
      count: Math.max(penultimate.count, last.count),
    });
  }
  return runs;
}
