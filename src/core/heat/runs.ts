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
  // A leading run of a single point (possible when the state flips at i=1)
  // cannot form a LineString — merge it forward.
  const first = runs[0];
  const second = runs[1];
  if (first && second && first.startIdx === first.endIdx) {
    runs.splice(0, 2, {
      startIdx: first.startIdx,
      endIdx: second.endIdx,
      count: Math.max(first.count, second.count),
    });
  }
  return runs;
}
