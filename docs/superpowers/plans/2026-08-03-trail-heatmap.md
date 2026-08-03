# Trail Heatmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Same-category overlapping trail segments glow as a heatmap on the main map; tapping a hot point opens a right-edge vertical carousel of the activities passing there, and the focused card's route highlights.

**Architecture:** Pure corridor-grid binning in `src/core/heat/` (~25 m geographic cells, 1-ring dilation, per-trail cell traces → heat index → hot/cold run splitting). A `useTrackHeat` hook replaces `useTrackOverlays` on the main map, emitting ONE combined GeoJSON FeatureCollection (run features carry `trackId`/`categoryId`/`count`/`hot`/`color`) plus an O(1) `heatAt` tap lookup. MapScreen renders three data-driven line layers (glow / trace / focus highlight) and routes map taps: waypoint → heat carousel → single-trail inspection.

**Tech Stack:** TypeScript (strict + noUncheckedIndexedAccess), Jest for core, @maplibre/maplibre-react-native v11 (`GeoJSONSource` + `Layer type="line"`), react-native-paper `Surface`, Maestro E2E.

**Spec:** `docs/superpowers/specs/2026-08-02-trail-heatmap-design.md` — read it first.

## Global Constraints

- `src/core/**` stays pure: no `react-native`/`expo` imports; every new core file gets a co-located `*.test.ts` (coverage gate).
- Strict TS with `noUncheckedIndexedAccess`: guard index access (`arr[i]` is `T | undefined`), never cast it away.
- `npm run check` (typecheck + lint + format + tests) must pass after every task; lint allows ZERO warnings. Prettier: single quotes, semicolons, width 100.
- Path aliases: `@core`, `@data`, `@state`, `@features`, `@ui`, `@lib`, `@/`.
- No new dependencies. JS-only feature (ships as OTA).
- Never use paper `Portal`/`Dialog` over the map (invisible touch-swallowing overlay when animations are off).
- Category vocabulary: `TrackSummary.category?: string`; the built-in `'navigation'` category is excluded from heat (spec §5); trails with `category === undefined` form their own `'uncategorized'` heat group.
- Commit after every task (small commits, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer).

## File Structure

- Create `src/core/heat/grid.ts` (+ `grid.test.ts`) — cell math.
- Create `src/core/heat/trace.ts` (+ `trace.test.ts`) — points → cells, interpolation, dilation.
- Create `src/core/heat/heatIndex.ts` (+ `heatIndex.test.ts`) — cell → category → trail-ids index, lookups.
- Create `src/core/heat/runs.ts` (+ `runs.test.ts`) — hot/cold run splitting.
- Create `src/core/heat/color.ts` (+ `color.test.ts`) — hot colour variant.
- Create `src/core/heat/features.ts` (+ `features.test.ts`) — pure run-features builder (GeoJSON).
- Create `src/features/map/useTrackHeat.ts` — thin platform hook (GPX loading + caching + assembly).
- Create `src/features/map/components/HeatPointCarousel.tsx` — right-edge card stack.
- Modify `src/features/map/MapScreen.tsx` — combined source, three layers, tap routing, carousel state.
- Create `.maestro/heatmap.yaml`; modify `.github/scripts/e2e-attempts.sh` (12th flow).

---

### Task 1: Grid math — `src/core/heat/grid.ts`

**Files:**

- Create: `src/core/heat/grid.ts`
- Test: `src/core/heat/grid.test.ts`

**Interfaces:**

- Consumes: nothing (leaf module).
- Produces:
  - `export const HEAT_CELL_M = 25;`
  - `export interface Cell { row: number; col: number }`
  - `export function cellAt(lng: number, lat: number, cellSizeM?: number): Cell`
  - `export function cellKey(cell: Cell): string` — `"row,col"`.
  - `export function ringKeys(cell: Cell): string[]` — the cell plus its 8 neighbours (9 keys).

Grid design (from spec §1): rows are bands of constant real height — `row = floor(lat * M_PER_DEG_LAT / size)` with `M_PER_DEG_LAT = 111320`. Column width is cosine-corrected **at the row's own centre latitude** so cells stay ~25 m wide at any latitude while remaining deterministic (every caller computes the same col for the same lng): `col = floor(lng * M_PER_DEG_LAT * cos(rowCenterLatRad) / size)`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/core/heat/grid.test.ts
import { HEAT_CELL_M, cellAt, cellKey, ringKeys } from './grid';

describe('heat grid', () => {
  it('two points ~10 m apart share a cell; ~60 m apart do not', () => {
    // Mid-cell base: at 25 m cells this row spans lat 46.813915–46.814140,
    // so both points sit safely inside it (boundary-straddling data flaked).
    const a = cellAt(-71.2082, 46.814);
    const near = cellAt(-71.2082, 46.81404); // ~4.5 m north, same cell
    const far = cellAt(-71.2082, 46.8145); // ~56 m north
    expect(cellKey(near)).toBe(cellKey(a));
    expect(cellKey(far)).not.toBe(cellKey(a));
  });

  it('is deterministic: same input, same cell, regardless of call order', () => {
    const k1 = cellKey(cellAt(7.5, 60.0));
    const k2 = cellKey(cellAt(7.5, 60.0));
    expect(k1).toBe(k2);
  });

  it('cosine-corrects column width (lng degrees are shorter at high latitude)', () => {
    // 0.0005° lng ≈ 38 m at lat 46.8 (different col at 25 m cells)…
    const a = cellAt(-71.2082, 46.8139);
    const b = cellAt(-71.2077, 46.8139);
    expect(b.col).not.toBe(a.col);
    // …and the same lng delta at the equator is ~56 m: also different cols,
    // but MORE columns apart than at 46.8 would suggest without correction.
    const e1 = cellAt(0, 0.0001);
    const e2 = cellAt(0.0005, 0.0001);
    expect(Math.abs(e2.col - e1.col)).toBeGreaterThanOrEqual(2);
  });

  it('ringKeys returns 9 unique keys including the centre', () => {
    const c = cellAt(-71.2082, 46.8139);
    const ring = ringKeys(c);
    expect(ring).toHaveLength(9);
    expect(new Set(ring).size).toBe(9);
    expect(ring).toContain(cellKey(c));
  });

  it('honours a custom cell size', () => {
    const coarseA = cellAt(-71.2082, 46.8139, 250);
    const coarseB = cellAt(-71.2082, 46.8145, 250); // ~67 m north
    expect(cellKey(coarseA)).toBe(cellKey(coarseB));
    expect(HEAT_CELL_M).toBe(25);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/core/heat/grid.test.ts`
Expected: FAIL — cannot find module `./grid`.

- [ ] **Step 3: Implement**

```ts
// src/core/heat/grid.ts
/**
 * The heat grid: fixed geographic cells of ~HEAT_CELL_M real metres.
 * Rows are constant-height latitude bands; column width is cosine-corrected
 * at each row's centre latitude, so cells stay square-ish on the ground at
 * any latitude while every caller derives the identical cell for a
 * coordinate (the correction depends only on the row, never the input lat).
 */

export const HEAT_CELL_M = 25;

const M_PER_DEG_LAT = 111320;

export interface Cell {
  row: number;
  col: number;
}

export function cellAt(lng: number, lat: number, cellSizeM: number = HEAT_CELL_M): Cell {
  const row = Math.floor((lat * M_PER_DEG_LAT) / cellSizeM);
  const rowCenterLat = ((row + 0.5) * cellSizeM) / M_PER_DEG_LAT;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((rowCenterLat * Math.PI) / 180);
  const col = Math.floor((lng * mPerDegLng) / cellSizeM);
  return { row, col };
}

export function cellKey(cell: Cell): string {
  return `${cell.row},${cell.col}`;
}

/** The cell plus its 8 neighbours — the 1-ring dilation / fat-finger radius. */
export function ringKeys(cell: Cell): string[] {
  const keys: string[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      keys.push(`${cell.row + dr},${cell.col + dc}`);
    }
  }
  return keys;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/core/heat/grid.test.ts` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/heat/grid.ts src/core/heat/grid.test.ts
git commit -m "feat(heat): geographic cell grid for the trail heatmap"
```

---

### Task 2: Cell tracing — `src/core/heat/trace.ts`

**Files:**

- Create: `src/core/heat/trace.ts`
- Test: `src/core/heat/trace.test.ts`

**Interfaces:**

- Consumes: `cellAt`, `cellKey`, `ringKeys`, `HEAT_CELL_M` from `./grid`.
- Produces:
  - `export interface CellTrace { perPoint: string[]; dilated: Set<string> }`
  - `export function traceCells(points: readonly { latitude: number; longitude: number }[], cellSizeM?: number): CellTrace`

`perPoint[i]` is the (undilated) cell key of point `i` — run splitting consumes it. `dilated` is every cell the polyline passes through (interpolating along segments longer than half a cell so sparse GPS can't skip cells) plus the 1-ring dilation of each — matching consumes it.

- [ ] **Step 1: Write the failing tests**

```ts
// src/core/heat/trace.test.ts
import { cellAt, cellKey } from './grid';
import { traceCells } from './trace';

const pt = (lng: number, lat: number) => ({ longitude: lng, latitude: lat });

describe('traceCells', () => {
  it('perPoint has one key per input point', () => {
    const points = [pt(-71.2082, 46.8139), pt(-71.208, 46.814), pt(-71.2078, 46.8141)];
    const trace = traceCells(points);
    expect(trace.perPoint).toHaveLength(3);
    expect(trace.perPoint[0]).toBe(cellKey(cellAt(-71.2082, 46.8139)));
  });

  it('interpolates long segments: a 200 m hop leaves no cell gaps', () => {
    // ~200 m north in one segment; must touch every ~25 m row between.
    const trace = traceCells([pt(-71.2082, 46.8139), pt(-71.2082, 46.8157)]);
    const rows = new Set([...trace.dilated].map((k) => Number(k.split(',')[0])));
    const min = Math.min(...rows);
    const max = Math.max(...rows);
    for (let r = min; r <= max; r++) expect(rows.has(r)).toBe(true);
  });

  it('dilation: parallel traces ~20 m apart share cells; ~80 m apart do not', () => {
    // 0.00018° lat ≈ 20 m; 0.00072° ≈ 80 m.
    const line = (latOffset: number) => [
      pt(-71.2082, 46.8139 + latOffset),
      pt(-71.2075, 46.8139 + latOffset),
    ];
    const a = traceCells(line(0));
    const near = traceCells(line(0.00018));
    const far = traceCells(line(0.00072));
    const overlaps = (x: Set<string>, y: Set<string>) => [...x].some((k) => y.has(k));
    expect(overlaps(a.dilated, near.dilated)).toBe(true);
    expect(overlaps(a.dilated, far.dilated)).toBe(false);
  });

  it('handles empty and single-point inputs', () => {
    expect(traceCells([]).perPoint).toHaveLength(0);
    expect(traceCells([]).dilated.size).toBe(0);
    const single = traceCells([pt(-71.2082, 46.8139)]);
    expect(single.perPoint).toHaveLength(1);
    expect(single.dilated.size).toBe(9); // the cell + its ring
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/core/heat/trace.test.ts` — expected FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/core/heat/trace.ts
import { HEAT_CELL_M, cellAt, cellKey, ringKeys } from './grid';

/**
 * A track's footprint on the heat grid. `perPoint` (undilated) feeds run
 * splitting; `dilated` (segment-interpolated + 1-ring) feeds overlap
 * matching, so two GPS traces of the same physical path wobbling 10–20 m
 * apart still meet in shared cells.
 */
export interface CellTrace {
  perPoint: string[];
  dilated: Set<string>;
}

const M_PER_DEG_LAT = 111320;

export function traceCells(
  points: readonly { latitude: number; longitude: number }[],
  cellSizeM: number = HEAT_CELL_M,
): CellTrace {
  const perPoint: string[] = [];
  const dilated = new Set<string>();

  const stamp = (lng: number, lat: number) => {
    for (const k of ringKeys(cellAt(lng, lat, cellSizeM))) dilated.add(k);
  };

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    perPoint.push(cellKey(cellAt(p.longitude, p.latitude, cellSizeM)));
    stamp(p.longitude, p.latitude);

    const next = points[i + 1];
    if (!next) continue;
    // Interpolate along the segment at half-cell spacing so a sparse
    // recording (or an imported route with long straight legs) cannot skip
    // grid cells between fixes.
    const dLatM = (next.latitude - p.latitude) * M_PER_DEG_LAT;
    const dLngM =
      (next.longitude - p.longitude) * M_PER_DEG_LAT * Math.cos((p.latitude * Math.PI) / 180);
    const lengthM = Math.hypot(dLatM, dLngM);
    const steps = Math.floor(lengthM / (cellSizeM / 2));
    for (let s = 1; s <= steps; s++) {
      const t = s / (steps + 1);
      stamp(
        p.longitude + (next.longitude - p.longitude) * t,
        p.latitude + (next.latitude - p.latitude) * t,
      );
    }
  }
  return { perPoint, dilated };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/core/heat/trace.test.ts` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/heat/trace.ts src/core/heat/trace.test.ts
git commit -m "feat(heat): cell tracing with segment interpolation and 1-ring dilation"
```

---

### Task 3: Heat index — `src/core/heat/heatIndex.ts`

**Files:**

- Create: `src/core/heat/heatIndex.ts`
- Test: `src/core/heat/heatIndex.test.ts`

**Interfaces:**

- Consumes: `Cell`, `ringKeys` from `./grid`.
- Produces:
  - `export interface HeatTrackInput { id: string; categoryId: string; dilated: ReadonlySet<string> }`
  - `export type HeatIndex = Map<string, Map<string, Set<string>>>` — cellKey → categoryId → trackIds.
  - `export function buildHeatIndex(tracks: readonly HeatTrackInput[]): HeatIndex`
  - `export function hotCountAt(index: HeatIndex, key: string, categoryId: string): number` — distinct same-category trails in that cell (0 when absent).
  - `export function trailsNear(index: HeatIndex, cell: Cell): { trackIds: string[]; hot: boolean }` — union over the cell's ring; `hot` when ANY category has ≥ 2 trails there; `trackIds` is every trail (all categories) in the ring, deduped, insertion order.

**Caller contract (enforced in Task 7, not here):** navigation-category tracks are never passed in; `categoryId` for uncategorized tracks is the literal `'uncategorized'`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/core/heat/heatIndex.test.ts
import { buildHeatIndex, hotCountAt, trailsNear } from './heatIndex';

const input = (id: string, categoryId: string, keys: string[]) => ({
  id,
  categoryId,
  dilated: new Set(keys),
});

describe('heat index', () => {
  it('counts distinct same-category trails per cell', () => {
    const index = buildHeatIndex([
      input('a', 'run', ['0,0', '0,1']),
      input('b', 'run', ['0,1', '0,2']),
      input('c', 'run', ['0,1']),
    ]);
    expect(hotCountAt(index, '0,1', 'run')).toBe(3);
    expect(hotCountAt(index, '0,0', 'run')).toBe(1);
    expect(hotCountAt(index, '9,9', 'run')).toBe(0);
  });

  it('never mixes categories', () => {
    const index = buildHeatIndex([input('a', 'run', ['0,0']), input('b', 'hike', ['0,0'])]);
    expect(hotCountAt(index, '0,0', 'run')).toBe(1);
    expect(hotCountAt(index, '0,0', 'hike')).toBe(1);
  });

  it('trailsNear unions the ring and reports hot per any-category >= 2', () => {
    const index = buildHeatIndex([
      input('a', 'run', ['5,5']),
      input('b', 'run', ['5,6']), // neighbour of 5,5 → in the ring
      input('c', 'hike', ['5,5']),
    ]);
    const at = trailsNear(index, { row: 5, col: 5 });
    expect(at.trackIds).toEqual(['a', 'b', 'c']);
    expect(at.hot).toBe(true); // two 'run' trails in the ring
    const cold = trailsNear(index, { row: 50, col: 50 });
    expect(cold.trackIds).toEqual([]);
    expect(cold.hot).toBe(false);
  });

  it('a single trail everywhere is never hot', () => {
    const index = buildHeatIndex([input('a', 'run', ['1,1', '1,2'])]);
    expect(trailsNear(index, { row: 1, col: 1 }).hot).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/core/heat/heatIndex.test.ts` — expected FAIL.

- [ ] **Step 3: Implement**

```ts
// src/core/heat/heatIndex.ts
import { ringKeys, type Cell } from './grid';

/** One visible performed trail's footprint (never navigation trails). */
export interface HeatTrackInput {
  id: string;
  categoryId: string;
  dilated: ReadonlySet<string>;
}

/** cellKey → categoryId → the distinct trail ids touching that cell. */
export type HeatIndex = Map<string, Map<string, Set<string>>>;

export function buildHeatIndex(tracks: readonly HeatTrackInput[]): HeatIndex {
  const index: HeatIndex = new Map();
  for (const track of tracks) {
    for (const key of track.dilated) {
      let byCategory = index.get(key);
      if (!byCategory) {
        byCategory = new Map();
        index.set(key, byCategory);
      }
      let ids = byCategory.get(track.categoryId);
      if (!ids) {
        ids = new Set();
        byCategory.set(track.categoryId, ids);
      }
      ids.add(track.id);
    }
  }
  return index;
}

export function hotCountAt(index: HeatIndex, key: string, categoryId: string): number {
  return index.get(key)?.get(categoryId)?.size ?? 0;
}

/**
 * Everything at (or one cell around) a tap: all trail ids in the ring in
 * insertion order, and whether any single category runs >= 2 trails there.
 */
export function trailsNear(index: HeatIndex, cell: Cell): { trackIds: string[]; hot: boolean } {
  const trackIds: string[] = [];
  const seen = new Set<string>();
  let hot = false;
  for (const key of ringKeys(cell)) {
    const byCategory = index.get(key);
    if (!byCategory) continue;
    for (const ids of byCategory.values()) {
      if (ids.size >= 2) hot = true;
      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id);
          trackIds.push(id);
        }
      }
    }
  }
  return { trackIds, hot };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/core/heat/heatIndex.test.ts` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/heat/heatIndex.ts src/core/heat/heatIndex.test.ts
git commit -m "feat(heat): per-cell per-category heat index with ring lookup"
```

---

### Task 4: Run splitting — `src/core/heat/runs.ts`

**Files:**

- Create: `src/core/heat/runs.ts`
- Test: `src/core/heat/runs.test.ts`

**Interfaces:**

- Consumes: nothing from siblings (pure over inputs).
- Produces:
  - `export interface HeatRun { startIdx: number; endIdx: number; count: number }` — inclusive point indices; `count` is 1 for cold runs, else the max same-category trail count seen along the run (≥ 2).
  - `export function splitHeatRuns(perPoint: readonly string[], countAt: (key: string) => number): HeatRun[]`

Adjacent runs SHARE their boundary point (`runs[n].endIdx === runs[n+1].startIdx`) so the drawn line has no gaps (spec §1). Runs shorter than 2 points are merged into their neighbour (a LineString needs 2+ positions).

- [ ] **Step 1: Write the failing tests**

```ts
// src/core/heat/runs.test.ts
import { splitHeatRuns } from './runs';

describe('splitHeatRuns', () => {
  const countFor = (hotKeys: Record<string, number>) => (key: string) => hotKeys[key] ?? 1;

  it('one all-cold run for a never-hot trace', () => {
    const runs = splitHeatRuns(['a', 'b', 'c'], countFor({}));
    expect(runs).toEqual([{ startIdx: 0, endIdx: 2, count: 1 }]);
  });

  it('splits cold→hot→cold with shared boundary points', () => {
    const runs = splitHeatRuns(['a', 'a', 'h', 'h', 'h', 'b', 'b'], countFor({ h: 3 }));
    expect(runs).toEqual([
      { startIdx: 0, endIdx: 2, count: 1 },
      { startIdx: 2, endIdx: 5, count: 3 },
      { startIdx: 5, endIdx: 6, count: 1 },
    ]);
  });

  it('keeps the max count over a hot run', () => {
    const runs = splitHeatRuns(['h2', 'h5', 'h2'], countFor({ h2: 2, h5: 5 }));
    expect(runs).toEqual([{ startIdx: 0, endIdx: 2, count: 5 }]);
  });

  it('returns [] for fewer than 2 points', () => {
    expect(splitHeatRuns([], countFor({}))).toEqual([]);
    expect(splitHeatRuns(['a'], countFor({}))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/core/heat/runs.test.ts` — expected FAIL.

- [ ] **Step 3: Implement**

```ts
// src/core/heat/runs.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/core/heat/runs.test.ts` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/heat/runs.ts src/core/heat/runs.test.ts
git commit -m "feat(heat): hot/cold run splitting with shared boundary points"
```

---

### Task 5: Hot colour variant — `src/core/heat/color.ts`

**Files:**

- Create: `src/core/heat/color.ts`
- Test: `src/core/heat/color.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `export function hotColor(hex: string): string` — a saturation-boosted, mid-lightness variant of a `#rrggbb` colour (the category colour's "glowing" form). Deterministic, returns `#rrggbb`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/core/heat/color.test.ts
import { hotColor } from './color';

describe('hotColor', () => {
  it('returns a valid #rrggbb hex distinct from the input', () => {
    const out = hotColor('#aeccdf'); // the pastel-river blue
    expect(out).toMatch(/^#[0-9a-f]{6}$/);
    expect(out).not.toBe('#aeccdf');
  });

  it('is deterministic', () => {
    expect(hotColor('#e07a5f')).toBe(hotColor('#e07a5f'));
  });

  it('boosts saturation: a pastel becomes more chromatic (max-min channel spread grows)', () => {
    const spread = (hex: string) => {
      const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return Math.max(...v) - Math.min(...v);
    };
    expect(spread(hotColor('#aeccdf'))).toBeGreaterThan(spread('#aeccdf'));
  });

  it('leaves pure grey usable (no NaN channels)', () => {
    expect(hotColor('#808080')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/core/heat/color.test.ts` — expected FAIL.

- [ ] **Step 3: Implement**

```ts
// src/core/heat/color.ts
/**
 * The "glowing" variant of a category colour: saturation pushed up and
 * lightness pulled toward the vivid middle, so hot segments read as an
 * intensified version of the same hue on both themes.
 */
export function hotColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s2 = Math.min(1, s * 1.5 + 0.15);
  const l2 = l * 0.55 + 0.5 * 0.45; // pull toward 0.5
  const c = (1 - Math.abs(2 * l2 - 1)) * s2;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l2 - c / 2;
  const [r2, g2, b2] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r2)}${toHex(g2)}${toHex(b2)}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/core/heat/color.test.ts` — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/heat/color.ts src/core/heat/color.test.ts
git commit -m "feat(heat): saturation-boosted hot colour variant"
```

---

### Task 6: Run-features builder — `src/core/heat/features.ts`

**Files:**

- Create: `src/core/heat/features.ts`
- Test: `src/core/heat/features.test.ts`

**Interfaces:**

- Consumes: `HeatRun` from `./runs`.
- Produces:
  - `export interface HeatRunProperties { trackId: string; categoryId: string; count: number; hot: boolean; color: string }`
  - `export function runFeatures(trackId: string, categoryId: string, points: readonly { latitude: number; longitude: number }[], runs: readonly HeatRun[], coldColor: string, hotColorHex: string): Feature<LineString, HeatRunProperties>[]` (types from `geojson` — already a dependency, imported type-only, so core stays pure).

- [ ] **Step 1: Write the failing tests**

```ts
// src/core/heat/features.test.ts
import { runFeatures } from './features';

const pts = [
  { longitude: -71.2082, latitude: 46.8139 },
  { longitude: -71.208, latitude: 46.814 },
  { longitude: -71.2078, latitude: 46.8141 },
  { longitude: -71.2076, latitude: 46.8142 },
];

describe('runFeatures', () => {
  it('builds one LineString per run with the right slice and properties', () => {
    const features = runFeatures(
      't1',
      'run',
      pts,
      [
        { startIdx: 0, endIdx: 2, count: 1 },
        { startIdx: 2, endIdx: 3, count: 3 },
      ],
      '#aabbcc',
      '#ff0000',
    );
    expect(features).toHaveLength(2);
    const cold = features[0];
    const hot = features[1];
    expect(cold?.geometry.coordinates).toHaveLength(3);
    expect(cold?.properties).toEqual({
      trackId: 't1',
      categoryId: 'run',
      count: 1,
      hot: false,
      color: '#aabbcc',
    });
    expect(hot?.geometry.coordinates).toEqual([
      [-71.2078, 46.8141],
      [-71.2076, 46.8142],
    ]);
    expect(hot?.properties.hot).toBe(true);
    expect(hot?.properties.color).toBe('#ff0000');
    expect(hot?.properties.count).toBe(3);
  });

  it('skips degenerate runs (fewer than 2 coordinates)', () => {
    const features = runFeatures(
      't1',
      'run',
      pts,
      [{ startIdx: 1, endIdx: 1, count: 1 }],
      '#aabbcc',
      '#ff0000',
    );
    expect(features).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/core/heat/features.test.ts` — expected FAIL.

- [ ] **Step 3: Implement**

```ts
// src/core/heat/features.ts
import type { Feature, LineString } from 'geojson';
import type { HeatRun } from './runs';

/** Properties every rendered run feature carries (data-driven styling). */
export interface HeatRunProperties {
  trackId: string;
  categoryId: string;
  count: number;
  hot: boolean;
  color: string;
}

export function runFeatures(
  trackId: string,
  categoryId: string,
  points: readonly { latitude: number; longitude: number }[],
  runs: readonly HeatRun[],
  coldColor: string,
  hotColorHex: string,
): Feature<LineString, HeatRunProperties>[] {
  const features: Feature<LineString, HeatRunProperties>[] = [];
  for (const run of runs) {
    const coordinates: [number, number][] = [];
    for (let i = run.startIdx; i <= run.endIdx; i++) {
      const p = points[i];
      if (p) coordinates.push([p.longitude, p.latitude]);
    }
    if (coordinates.length < 2) continue;
    const hot = run.count >= 2;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
      properties: {
        trackId,
        categoryId,
        count: run.count,
        hot,
        color: hot ? hotColorHex : coldColor,
      },
    });
  }
  return features;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/core/heat/features.test.ts` — expected PASS. Also run the full gate now: `npm run check` — expected exit 0 (core coverage must not regress).

- [ ] **Step 5: Commit**

```bash
git add src/core/heat/features.ts src/core/heat/features.test.ts
git commit -m "feat(heat): GeoJSON run-features builder"
```

---

### Task 7: `useTrackHeat` hook

**Files:**

- Create: `src/features/map/useTrackHeat.ts`
- Reference (do not modify): `src/features/map/useTrackOverlays.ts` — copy its GPX-loading + content-key caching pattern; `src/features/map/useTerrainOverlays2D.ts:113-116` — the `stale()` yield checkpoint.

**Interfaces:**

- Consumes: everything from Tasks 1–6; `categoryColor`, `findCategory` from `@core/library/categories`; `isPerformedActivity` from `@core/dashboard/aggregate` (predicate: `category !== 'navigation'`); `TrackSummary` from `@core/models/track`; `* as storage from '@data/storage'`; `parseGpx` from the same import site `useTrackOverlays.ts` uses; `useLibraryStore` for `customCategories`.
- Produces:

```ts
export interface TrackHeat {
  /** One FeatureCollection of ALL visible trails' run features. */
  collection: FeatureCollection<LineString, HeatRunProperties> | null;
  /** Tap lookup: all trails around the point + whether the spot is hot. */
  heatAt: (lngLat: { lng: number; lat: number }) => { trackIds: string[]; hot: boolean };
}
export function useTrackHeat(
  tracks: readonly TrackSummary[],
  shownTrackIds: readonly string[],
): TrackHeat;
```

Behaviour:

- Per-track cache (`useRef<Map<string, {key: string; points: TrackPoint[]; trace: CellTrace}>>`) keyed `` `${id}|${stats.pointCount}|${stats.distanceM}` `` — the `useTrackOverlays` content key. Missing/stale entries load + parse their GPX async with an `await new Promise(r => setTimeout(r, 0))` yield between tracks and a request-id bail (copy the `reqIdRef` pattern from `useTerrainOverlays2D`).
- **Navigation trails** (`!isPerformedActivity(track.category)`… note: `isPerformedActivity` takes the category string — check its exact signature in `@core/dashboard/aggregate` before use) still render: they get traced for `perPoint` but are EXCLUDED from `buildHeatIndex` inputs, so they are always all-cold, and their ids never appear in `heatAt` results (filter them out of `trailsNear` output by keeping a `Set` of performed ids).
- `categoryId` for the index: `track.category ?? 'uncategorized'`.
- Colours resolved per track at build time: `coldColor = categoryColor(track.category, customCategories) ?? mapColors.trackOverlay`, `hotColorHex = hotColor(coldColor)`.
- Recompute effect depends ONLY on `[tracks, shownTrackIds]` (content key changes flow through `tracks`) — never on camera state.
- `heatAt` converts lng/lat → `cellAt` → `trailsNear(index, cell)`, filters to performed ids, orders newest-first by `startedAt` (or the summary's date field — check `TrackSummary` for the exact name; `useTrackOverlays`/Library sorting shows it).
- No unit tests (platform file — all logic already tested in core). Typecheck + lint must pass.

- [ ] **Step 1: Read `useTrackOverlays.ts` fully** and copy its load/caching skeleton into the new hook. Verify `isPerformedActivity`'s signature in `src/core/dashboard/aggregate.ts` and the track date field name in `src/core/models/track.ts` before writing code.

- [ ] **Step 2: Implement `useTrackHeat.ts`** per the interface above.

- [ ] **Step 3: Verify** `npm run check` — expected exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/features/map/useTrackHeat.ts
git commit -m "feat(heat): useTrackHeat hook — combined run features + tap lookup"
```

---

### Task 8: MapScreen rendering swap (combined source, three layers, category colours)

**Files:**

- Modify: `src/features/map/MapScreen.tsx` — the per-trail sources block (currently `trackOverlays.map(...)` around lines 717–741; grep `track-${t.id}` to find it).

**Interfaces:**

- Consumes: `useTrackHeat` (Task 7).
- Produces (used by Task 9): component state `heatSelection: { lngLat: {lng: number; lat: number}; trackIds: string[]; focusedIdx: number } | null` and `const trackHeat = useTrackHeat(tracks, shownTrackIds);` in scope.

Changes:

1. Add `const trackHeat = useTrackHeat(tracks, shownTrackIds);` alongside the existing `useTrackOverlays` call, then REMOVE the `useTrackOverlays` call and its render block once the new layers work. Check for other `useTrackOverlays` consumers first (`grep -rn useTrackOverlays src/`); if MapScreen is the only one, leave the file in place but unused by MapScreen (do not delete the file — 3D wiring may import helpers from it).
2. Render, in place of the per-trail sources (order matters — glow under trace under highlight):

```tsx
{
  trackHeat.collection && (
    <GeoJSONSource id="tracks-heat" data={trackHeat.collection}>
      <Layer
        id="tracks-heat-glow"
        type="line"
        filter={['==', ['get', 'hot'], true]}
        style={{
          lineColor: ['get', 'color'],
          lineWidth: ['step', ['get', 'count'], 10, 3, 13, 5, 16],
          lineBlur: 6,
          lineOpacity: 0.35,
          lineCap: 'round',
          lineJoin: 'round',
        }}
      />
      <Layer
        id="tracks-heat-line"
        type="line"
        style={{
          lineColor: ['get', 'color'],
          lineWidth: [
            'case',
            ['==', ['get', 'hot'], true],
            ['step', ['get', 'count'], 5, 3, 6, 5, 7],
            4,
          ],
          lineOpacity: dimOthers
            ? ['case', ['==', ['get', 'trackId'], focusedTrackId ?? ''], 1, 0.25]
            : 1,
          lineCap: 'round',
          lineJoin: 'round',
        }}
      />
      <Layer
        id="tracks-heat-focus"
        type="line"
        filter={['==', ['get', 'trackId'], focusedTrackId ?? '']}
        style={{ lineColor: ['get', 'color'], lineWidth: 7, lineOpacity: 1 }}
      />
    </GeoJSONSource>
  );
}
```

where `const focusedTrackId = heatSelection ? heatSelection.trackIds[heatSelection.focusedIdx] ?? null : inspectId;` and `const dimOthers = heatSelection !== null;`. (Exact `Layer` style-prop typings: mirror how the existing contour/trim layers in this file type their expressions; adjust `as` casts only if the v11 typings require them, matching the file's existing idiom.)

3. The old per-source `onPress={() => inspect(...)}` dies with the removed block — Task 9 restores trail taps via `onMapPress`. The existing scrub-marker `circle` layer and trim-preview layers stay untouched.
4. Trim mode reads the inspected trail's own feature — verify the trim preview source does not depend on the removed per-trail sources (grep `trim` in the file; if it built its preview from `trackOverlays`, feed it from `trackHeat.collection` features filtered by `trackId === inspectId` or from `inspectPoints`, whichever the existing code already holds).

- [ ] **Step 1: Implement the swap** as above.
- [ ] **Step 2: Verify** `npm run check` — exit 0.
- [ ] **Step 3: Manual smoke on the emulator** — build is NOT needed for JS: use the dev client if available, otherwise defer visual verification to Task 11's release build. At minimum: typecheck/lint/tests green.
- [ ] **Step 4: Commit**

```bash
git add src/features/map/MapScreen.tsx
git commit -m "feat(heat): combined heat source + category-coloured layers on the main map"
```

---

### Task 9: Tap routing + `HeatPointCarousel`

**Files:**

- Create: `src/features/map/components/HeatPointCarousel.tsx`
- Modify: `src/features/map/MapScreen.tsx` (`onMapPress`, carousel render, tapped-point ring)
- Reference (do not modify): `src/features/map/components/CategoryStartSheet.tsx` (the non-Portal Surface sheet idiom), `src/features/map/components/WaypointViewerCard.tsx` (absolute card styling), the waypoint hit-test inside `onMapPress` (`MapScreen.tsx` ~496–543).

**Interfaces:**

- Consumes: `heatSelection` state + `trackHeat.heatAt` (Task 8), `useTrailInspection`'s `inspect(id)`, `categoryColor`/`findCategory`, `formatDistance`/duration formatter from `@lib/format` (grep the exact duration helper the Library trail cards use and reuse it).
- Produces:

```tsx
export function HeatPointCarousel({
  trackIds,
  tracks,
  focusedIdx,
  onFocus,
  onOpenTrail,
  onClose,
  topInset,
}: {
  trackIds: readonly string[];
  tracks: readonly TrackSummary[]; // full summaries; component maps ids → summaries
  focusedIdx: number;
  onFocus: (idx: number) => void;
  onOpenTrail: (id: string) => void;
  onClose: () => void;
  topInset: number;
}): JSX.Element;
```

Behaviour:

1. **onMapPress priority** (extend the existing handler; it currently hit-tests waypoint pins first — keep that first): waypoint pin hit → existing behaviour; else `const at = trackHeat.heatAt(tapLngLat)` (the press event's `geometry.coordinates` gives `[lng, lat]` — same event shape the existing handler uses); if `at.hot && at.trackIds.length >= 2` → `setHeatSelection({ lngLat, trackIds: at.trackIds, focusedIdx: 0 })`; else if `at.trackIds.length === 1` → `inspect(at.trackIds[0] ?? null)`; else → `setHeatSelection(null)` and existing empty-tap behaviour (deselect).
2. **Carousel component**: absolutely-positioned themed `View` (NOT paper Portal; follow `CategoryStartSheet`'s Surface-substitute comment — on iOS use a plain themed View per the Paper-Surface-flex-collapse gotcha), pinned `right: 8`, vertically centred (`top: topInset + 90`), width ~200, max 4 visible cards in a `ScrollView` with `snapToInterval={CARD_H + GAP}`, `showsVerticalScrollIndicator={false}`, `onMomentumScrollEnd` → derive index from `contentOffset.y` → `onFocus(index)`. Each card: category icon (`findCategory(...)?.icon ?? 'circle-medium'`) tinted with the category colour, name (1 line, ellipsize), date line, `distance · duration` line (omit duration when untimed — untimed = whatever the Library card logic checks; copy it). Focused card gets a 2 px accent border. Card `onPress`: if it IS the focused card → `onOpenTrail(id)`, else → `onFocus(itsIndex)`. A close (`×`) `IconButton` on the stack's top edge → `onClose`. Every card gets `accessibilityLabel={'Activity: ' + name}`; the container gets `accessibilityLabel="Activities here"` — the E2E flow asserts these exact strings.
3. **Ring marker** at `heatSelection.lngLat`: a one-feature `GeoJSONSource` + `circle` layer (`circleRadius: 9`, `circleColor: 'transparent'`, `circleStrokeWidth: 2.5`, `circleStrokeColor: theme.colors.primary`) rendered only while the carousel is open — copy the scrub-marker layer pattern already in the file.
4. Wire in MapScreen: `onOpenTrail={(id) => router.push(`/trail3d/${id}`)}` (grep how DashboardScreen imports/pushes the router for the exact idiom), `onFocus` updates `heatSelection.focusedIdx`, `onClose` sets `heatSelection` to null. Newest-first ordering already comes from `heatAt`.
5. Opening the carousel must hide the trail-inspection panel if open (`inspect(null)`), and vice versa: `inspect(...)` from a single-trail tap must `setHeatSelection(null)`.

- [ ] **Step 1: Implement the component + wiring** as above.
- [ ] **Step 2: Verify** `npm run check` — exit 0.
- [ ] **Step 3: Commit**

```bash
git add src/features/map/components/HeatPointCarousel.tsx src/features/map/MapScreen.tsx
git commit -m "feat(heat): tap routing + right-edge activity carousel with route highlight"
```

---

### Task 10: E2E flow — `.maestro/heatmap.yaml`

**Files:**

- Create: `.maestro/heatmap.yaml`
- Modify: `.github/scripts/e2e-attempts.sh` — insert `.maestro/heatmap.yaml` into the flow list AFTER `category-record.yaml` (it reuses its fixture) and BEFORE `library-filter.yaml`.
- Reference: `.maestro/category-record.yaml` for the record-a-run steps (copy its selectors verbatim).

The suite's geo-fix loop replays the same two coordinates forever, so two recordings deterministically overlap. `category-record.yaml` already saved one Run; this flow records a SECOND Run over the same path, then taps the trail area.

```yaml
# Heatmap e2e: a second Run over the same simulated path as
# category-record's makes the shared stretch hot; tapping it opens the
# vertical activity carousel; focusing + tapping a card opens the viewer.
#
# MUST run after category-record.yaml (its Run trail is the first overlap
# partner). The camera follows the user location (the geo fixes), so after
# saving, the overlapping trace sits at the screen centre — the 40%..60%
# tap grid below is a deliberately generous net around it (heat lookup has
# a one-cell fat-finger ring).
appId: com.inukshuk.app
---
- runFlow:
    when:
      platform: Android
    commands:
      - launchApp:
          permissions:
            location: allow
            notifications: allow
- runFlow:
    when:
      platform: iOS
    commands:
      - launchApp:
          permissions:
            location: always
- extendedWaitUntil:
    visible: 'Map actions'
    timeout: 30000
# Record the second Run — same steps as category-record.yaml (copy its
# selectors verbatim when authoring; summarized here):
#   open the "+" dial → Record → pick the Run category → wait for fixes →
#   stop → save. Reuse its extendedWaitUntil timeouts unchanged.
# [AUTHOR: paste category-record.yaml's record+save block here verbatim]
# After save the map shows both runs overlapping at the centre.
- tapOn:
    point: '50%,50%'
- runFlow:
    when:
      notVisible: 'Activities here'
    commands:
      - tapOn:
          point: '45%,45%'
- runFlow:
    when:
      notVisible: 'Activities here'
    commands:
      - tapOn:
          point: '55%,55%'
- extendedWaitUntil:
    visible: 'Activities here'
    timeout: 10000
# Two cards minimum (both are auto-titled "<TimeOfDay> run · <place>" or
# date-defaulted "Trail …").
- assertVisible:
    text: 'Activity: .*'
    index: 1
# Tap the focused (first) card → trail viewer.
- tapOn:
    text: 'Activity: .*'
    index: 0
- extendedWaitUntil:
    visible: 'Notes.*'
    timeout: 30000
- tapOn: 'Back'
- extendedWaitUntil:
    visible: 'Map actions'
    timeout: 15000
```

- [ ] **Step 1: Author the flow**, pasting category-record's record/save block verbatim where marked (the `[AUTHOR: …]` line must NOT survive into the committed file).
- [ ] **Step 2: Wire into `e2e-attempts.sh`** (12th flow, after category-record).
- [ ] **Step 3: Iterate on the emulator until green** — release APK on the headless emulator (`-no-window -gpu swiftshader_indirect`; windowed runs flake), geo-fix loop running. If the centre-tap net misses the trace, widen the fallback taps rather than adding sleeps.
- [ ] **Step 4: Commit**

```bash
git add .maestro/heatmap.yaml .github/scripts/e2e-attempts.sh
git commit -m "test(heat): heatmap e2e flow — overlap, carousel, viewer round-trip"
```

---

### Task 11: Full gate, visual counter-validation, ship

- [ ] **Step 1:** `npm run check` — exit 0.
- [ ] **Step 2:** Build the release APK (`cd android && ./gradlew assembleRelease`, JAVA_HOME=openjdk@17), fresh-install on the HEADLESS emulator, run all 12 flows (suite scripts + geo loop; `maestro test flow > log; s=$?` — never pipe, never `${PIPESTATUS}` in zsh).
- [ ] **Step 3:** iOS: `xcodebuild -workspace Inukshuk.xcworkspace -scheme Inukshuk -configuration Release -sdk iphonesimulator -derivedDataPath build-sim …`, install on the iPhone 16e sim, run all 12 flows via `maestro --device <udid>`. (If the build fails on a pods mismatch: `rm -rf ios/Pods ios/Podfile.lock && npx pod-install ios`.)
- [ ] **Step 4:** Visual counter-validation on the WINDOWED emulator with the demo fixtures: overlapping same-category trails glow with the count-stepped width; solo stretches are thin category-coloured lines; navigation trails never glow; tap → carousel → swipe → highlight follows; both light AND dark themes (Settings → theme toggle). Take screenshots for the PR.
- [ ] **Step 5:** PR (`gh pr create`) with the test plan + screenshots; wait for CI green; squash-merge.
- [ ] **Step 6:** OTA: the merge auto-publishes runtime 1.5.0; then `gh workflow run ota-update.yml -f app_version_override=1.4.0` for the legacy runtime. Verify both runs log "Published!" with the right runtime versions.
- [ ] **Step 7:** Re-present the windowed emulator on the map with overlapping demo trails for the user.
