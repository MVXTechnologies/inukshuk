import type { Json } from '@core/team/canonical';
import { compareWrites } from '@core/group/conflicts';
import { forAll, int, mulberry32, pick } from '@core/team/testing/prop';

import { historyKey, recordBeaten, recordConflicts, removalOf } from './history';
import { LFO, LIT } from './kinds';
import { canonicalView, LibSim, mid, MIN, OWNER, ROOT, T0 } from './testUtils';
import { edit, newFolder, newItem, restore, trash } from './writes';

/**
 * The library end to end over the fold: several editors work offline on the
 * same few records with skewed clocks, sync at random, then everyone syncs.
 *
 * - **Convergence**: every phone ends with the same tree and the same
 *   conflicts, and the same as a fold of the whole op set.
 * - **Conflicts exactly when two editors edited from the same knowledge**:
 *   for each field, the listed versions are exactly the writes no other
 *   write's phone knew of (ground truth: what each phone knew when it wrote).
 * - **Delete beats edit, and says so**: a trashed record lists exactly the
 *   edits the deleting phone did not know of and whose phones did not know of
 *   the delete.
 */
const EDITORS = [mid('ju'), mid('no'), mid('al'), mid('sa')];
const RECORDS: readonly [typeof LFO | typeof LIT, string][] = [
  [LIT, 'w1'],
  [LIT, 'w2'],
  [LFO, 'f1'],
];
const FIELDS = ['n', 'd', 'o'];

function run(seed: number) {
  const rnd = mulberry32(seed);
  const sim = new LibSim(Object.fromEntries(EDITORS.map((e) => [e, 'member'])));
  sim.meta(T0);
  sim.set(OWNER, T0 + 1, newFolder(ROOT, 'Shared'));
  sim.set(OWNER, T0 + 2, newItem('w1', 'wpt', 'One', ROOT));
  sim.set(OWNER, T0 + 3, newItem('w2', 'trk', 'Two', ROOT));
  sim.set(OWNER, T0 + 4, newFolder('f1', 'Sub', ROOT));
  sim.syncAll(T0 + 5);
  /** Op id → the op ids its phone knew when writing. */
  const knew = new Map<string, Set<string>>();
  const skew = new Map(EDITORS.map((e) => [e, int(rnd, -10, 10) * MIN]));
  let now = T0 + MIN;
  const steps = int(rnd, 5, 50);
  for (let s = 0; s < steps; s++) {
    now += int(rnd, 0, 90) * 1000;
    const who = pick(rnd, EDITORS);
    const r = rnd();
    if (r < 0.6) {
      const [kind, id] = pick(rnd, RECORDS);
      const h = sim.look(who).history;
      const local = now + skew.get(who)!;
      const k = rnd();
      let body;
      if (k < 0.12) body = trash(h, who, kind, id);
      else if (k < 0.2) body = restore(h, who, kind, id);
      else {
        const f: Record<string, Json> = {};
        for (const name of FIELDS)
          if (rnd() < 0.5) f[name] = name === 'o' ? int(rnd, 0, 9) : `${name}${s}`;
        if (Object.keys(f).length === 0) f['n'] = `n${s}`;
        body = edit(h, who, kind, id, f);
      }
      const known = new Set(sim.phone(who).known);
      const op = sim.set(who, local, body);
      knew.set(op.id, known);
    } else {
      sim.deliver(who, pick(rnd, EDITORS), now);
    }
  }
  return { sim, knew, now };
}

describe('property: library convergence and conflict truth (500 seeded worlds)', () => {
  it('converges, and surfaces exactly the concurrent writes', () => {
    let conflicted = 0;
    let beatenSeen = 0;
    forAll(
      7120,
      500,
      (rnd) => int(rnd, 0, 2 ** 31),
      (seed) => {
        const { sim, knew, now } = run(seed);
        const whole = sim.look();
        sim.syncAll(now + MIN);
        const looks = [...sim.phones.keys()].map((id) => sim.look(id));
        const canon = (l: typeof whole) =>
          canonicalView(l.view) +
          JSON.stringify(
            RECORDS.map(([k, id]) => [
              recordConflicts(l.history, k, id).map((c) => [
                c.field,
                c.kept.write.id,
                c.others.map((o) => o.write.id),
              ]),
              recordBeaten(l.history, k, id)?.edits.map((e) => e.id),
            ]),
          );
        const reference = canon(whole);
        for (const l of looks) expect(canon(l)).toBe(reference);

        const saw = (a: string, b: string) => knew.get(a)?.has(b) === true;
        for (const [kind, id] of RECORDS) {
          const ws = whole.history.records.get(historyKey(kind, id)) ?? [];
          const tracked = ws.filter((w) => knew.has(w.id));
          for (const field of FIELDS) {
            const writers = tracked.filter((w) => Object.hasOwn(w.fields, field));
            const truth = writers
              .filter((x) => !writers.some((y) => y !== x && saw(y.id, x.id)))
              .map((x) => x.id);
            // The owner's creating write was known by everyone: only tracked writes compete.
            const all = ws.filter((w) => Object.hasOwn(w.fields, field));
            const createOnly = all.length > 0 && tracked.length === 0;
            const c = recordConflicts(whole.history, kind, id).find((x) => x.field === field);
            const got = c ? [c.kept.write.id, ...c.others.map((o) => o.write.id)] : [];
            if (got.length > 0) conflicted += 1;
            if (createOnly) expect(got).toEqual([]);
            else expect(got.sort()).toEqual(truth.length > 1 ? truth.sort() : []);
          }
          // Delete beats edit: the newest trash/restore decides; while trashed, the
          // edits listed are exactly those concurrent with the trashing write.
          const classified = ws.filter((w) => removalOf(w) !== undefined).sort(compareWrites);
          const decider = classified[classified.length - 1];
          const beaten = recordBeaten(whole.history, kind, id);
          if (decider === undefined || removalOf(decider) !== 'remove') {
            expect(beaten).toBeUndefined();
          } else {
            const expected = tracked
              .filter(
                (e) =>
                  removalOf(e) === undefined &&
                  e.stamp.author !== decider.stamp.author &&
                  !saw(decider.id, e.id) &&
                  !saw(e.id, decider.id),
              )
              .map((e) => e.id);
            expect(beaten?.edits.map((e) => e.id) ?? []).toEqual(expected);
            if (expected.length > 0) beatenSeen += 1;
          }
        }
      },
    );
    // The worlds do produce both (or the property proves nothing).
    expect(conflicted).toBeGreaterThan(100);
    expect(beatenSeen).toBeGreaterThan(20);
  });
});
