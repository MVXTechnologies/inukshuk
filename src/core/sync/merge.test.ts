import { MAX_FUTURE_SKEW_MS } from './clock';
import { clampReplicaView, planMerge, type MergePlan, type ReplicaView } from './merge';

const view = (
  live: Record<string, number> = {},
  tombstones: Record<string, number> = {},
): ReplicaView => ({ live, tombstones });

const emptyPlanBits = { applyRemote: [], deleteLocal: [], pushLocal: [], pushDelete: [] };

describe('planMerge — both sides live', () => {
  it('local newer wins → push local', () => {
    expect(planMerge(view({ a: 200 }), view({ a: 100 }))).toEqual<MergePlan>({
      ...emptyPlanBits,
      pushLocal: ['a'],
      merged: view({ a: 200 }),
    });
  });

  it('remote newer wins → apply remote', () => {
    expect(planMerge(view({ a: 100 }), view({ a: 200 }))).toEqual<MergePlan>({
      ...emptyPlanBits,
      applyRemote: ['a'],
      merged: view({ a: 200 }),
    });
  });

  it('exact tie → already in sync, no action (server copy is authoritative)', () => {
    expect(planMerge(view({ a: 100 }), view({ a: 100 }))).toEqual<MergePlan>({
      ...emptyPlanBits,
      merged: view({ a: 100 }),
    });
  });
});

describe('planMerge — tombstone vs edit', () => {
  it('remote tombstone newer than local edit → delete locally', () => {
    expect(planMerge(view({ a: 100 }), view({}, { a: 150 }))).toEqual<MergePlan>({
      ...emptyPlanBits,
      deleteLocal: ['a'],
      merged: view({}, { a: 150 }),
    });
  });

  it('local edit newer than remote tombstone → push local (resurrects on server)', () => {
    expect(planMerge(view({ a: 200 }), view({}, { a: 150 }))).toEqual<MergePlan>({
      ...emptyPlanBits,
      pushLocal: ['a'],
      merged: view({ a: 200 }),
    });
  });

  it('local tombstone newer than remote edit → push the delete', () => {
    expect(planMerge(view({}, { a: 200 }), view({ a: 150 }))).toEqual<MergePlan>({
      ...emptyPlanBits,
      pushDelete: ['a'],
      merged: view({}, { a: 200 }),
    });
  });

  it('remote edit newer than local tombstone → apply remote (resurrects locally)', () => {
    expect(planMerge(view({}, { a: 100 }), view({ a: 150 }))).toEqual<MergePlan>({
      ...emptyPlanBits,
      applyRemote: ['a'],
      merged: view({ a: 150 }),
    });
  });

  it('tie between local edit and remote tombstone → tombstone wins, delete locally', () => {
    expect(planMerge(view({ a: 100 }), view({}, { a: 100 }))).toEqual<MergePlan>({
      ...emptyPlanBits,
      deleteLocal: ['a'],
      merged: view({}, { a: 100 }),
    });
  });

  it('tie between local tombstone and remote edit → tombstone wins, push the delete', () => {
    // Side-independent with the case above: whichever replica runs the merge,
    // an exact edit/delete tie resolves to the deletion — never a divergent
    // "each side keeps its own" split.
    expect(planMerge(view({}, { a: 100 }), view({ a: 100 }))).toEqual<MergePlan>({
      ...emptyPlanBits,
      pushDelete: ['a'],
      merged: view({}, { a: 100 }),
    });
  });
});

describe('planMerge — both sides deleted', () => {
  it('converges tombstones to the newest stamp with no actions', () => {
    expect(planMerge(view({}, { a: 100 }), view({}, { a: 300 }))).toEqual<MergePlan>({
      ...emptyPlanBits,
      merged: view({}, { a: 300 }),
    });
    expect(planMerge(view({}, { a: 100 }), view({}, { a: 100 }))).toEqual<MergePlan>({
      ...emptyPlanBits,
      merged: view({}, { a: 100 }),
    });
  });
});

describe('planMerge — one-sided items', () => {
  it('local-only live item → push it (first upload)', () => {
    expect(planMerge(view({ a: 100 }), view())).toEqual<MergePlan>({
      ...emptyPlanBits,
      pushLocal: ['a'],
      merged: view({ a: 100 }),
    });
  });

  it('remote-only live item → apply it (first download)', () => {
    expect(planMerge(view(), view({ a: 100 }))).toEqual<MergePlan>({
      ...emptyPlanBits,
      applyRemote: ['a'],
      merged: view({ a: 100 }),
    });
  });

  it('local-only tombstone → push the delete (parks it server-side)', () => {
    expect(planMerge(view({}, { a: 100 }), view())).toEqual<MergePlan>({
      ...emptyPlanBits,
      pushDelete: ['a'],
      merged: view({}, { a: 100 }),
    });
  });

  it('remote-only tombstone → adopt it with no action (nothing to delete)', () => {
    expect(planMerge(view(), view({}, { a: 100 }))).toEqual<MergePlan>({
      ...emptyPlanBits,
      merged: view({}, { a: 100 }),
    });
  });

  it('both sides empty → empty plan', () => {
    expect(planMerge(view(), view())).toEqual<MergePlan>({ ...emptyPlanBits, merged: view() });
  });
});

describe('planMerge — corrupt replica listing an id as both live and tombstoned', () => {
  it('resolves within the replica first: newer stamp wins, tombstone wins ties', () => {
    // Local claims a is both live@100 and deleted@100 → tombstone; remote live@50.
    expect(planMerge(view({ a: 100 }, { a: 100 }), view({ a: 50 }))).toEqual<MergePlan>({
      ...emptyPlanBits,
      pushDelete: ['a'],
      merged: view({}, { a: 100 }),
    });
    // Live@200 beats its own stale tombstone@100, then ordinary LWW applies.
    expect(planMerge(view({ a: 200 }, { a: 100 }), view({ a: 50 }))).toEqual<MergePlan>({
      ...emptyPlanBits,
      pushLocal: ['a'],
      merged: view({ a: 200 }),
    });
  });
});

describe('planMerge — multiple items and determinism', () => {
  it('handles independent items in one pass, ids sorted deterministically', () => {
    const local = view({ a: 100, b: 300 }, { c: 500 });
    const remote = view({ a: 200, d: 50 }, { b: 250 });
    expect(planMerge(local, remote)).toEqual<MergePlan>({
      applyRemote: ['a', 'd'],
      deleteLocal: [],
      pushLocal: ['b'],
      pushDelete: ['c'],
      merged: view({ a: 200, b: 300, d: 50 }, { c: 500 }),
    });
  });

  it('is idempotent: merging the merged view against itself plans nothing', () => {
    const { merged } = planMerge(
      view({ a: 100, b: 300 }, { c: 500 }),
      view({ a: 200 }, { b: 350 }),
    );
    expect(planMerge(merged, merged)).toEqual<MergePlan>({ ...emptyPlanBits, merged });
  });
});

describe('planMerge — convergence property', () => {
  // Tiny deterministic PRNG (xorshift32) — no dependency, reproducible failures.
  const rng = (seed: number) => () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };

  const randomView = (rand: () => number): ReplicaView => {
    const live: Record<string, number> = {};
    const tombstones: Record<string, number> = {};
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      const roll = rand();
      const stamp = 1 + Math.floor(rand() * 5); // small range forces frequent ties
      if (roll < 0.4) live[id] = stamp;
      else if (roll < 0.7) tombstones[id] = stamp;
      // else absent
    }
    return { live, tombstones };
  };

  it('merged is symmetric and executing the plan converges both replicas', () => {
    const rand = rng(0xc0ffee);
    for (let trial = 0; trial < 200; trial++) {
      const local = randomView(rand);
      const remote = randomView(rand);
      const plan = planMerge(local, remote);
      const mirrored = planMerge(remote, local);

      // Symmetry of the converged view.
      expect(mirrored.merged).toEqual(plan.merged);

      // Executing the plan: local applies remote wins, remote applies pushes.
      const nextLocal: ReplicaView = {
        live: { ...local.live },
        tombstones: { ...local.tombstones },
      };
      const nextRemote: ReplicaView = {
        live: { ...remote.live },
        tombstones: { ...remote.tombstones },
      };
      const mutate = (v: ReplicaView) =>
        v as { live: Record<string, number>; tombstones: Record<string, number> };
      for (const id of plan.applyRemote) {
        mutate(nextLocal).live[id] = plan.merged.live[id]!;
        delete mutate(nextLocal).tombstones[id];
      }
      for (const id of plan.deleteLocal) {
        delete mutate(nextLocal).live[id];
        mutate(nextLocal).tombstones[id] = plan.merged.tombstones[id]!;
      }
      for (const id of plan.pushLocal) {
        mutate(nextRemote).live[id] = plan.merged.live[id]!;
        delete mutate(nextRemote).tombstones[id];
      }
      for (const id of plan.pushDelete) {
        delete mutate(nextRemote).live[id];
        mutate(nextRemote).tombstones[id] = plan.merged.tombstones[id]!;
      }
      // Bookkeeping-only adoptions (no action emitted): merged stamps that
      // exist on neither action list — e.g. remote-only tombstones, and
      // newest-stamp convergence of both-deleted items.
      for (const [id, s] of Object.entries(plan.merged.tombstones)) {
        if (mutate(nextLocal).live[id] === undefined) mutate(nextLocal).tombstones[id] = s;
        if (mutate(nextRemote).live[id] === undefined) mutate(nextRemote).tombstones[id] = s;
      }
      for (const [id, s] of Object.entries(plan.merged.live)) {
        if (mutate(nextLocal).live[id] !== undefined) mutate(nextLocal).live[id] = s;
        if (mutate(nextRemote).live[id] !== undefined) mutate(nextRemote).live[id] = s;
      }

      expect(nextLocal).toEqual(plan.merged);
      expect(nextRemote).toEqual(plan.merged);
    }
  });
});

describe('clampReplicaView (clock-skew tolerance)', () => {
  const now = 1_700_000_000_000;

  it('leaves ordinary skew untouched — a device a few minutes fast still wins LWW', () => {
    const local = view({ a: now - 1_000 });
    const remoteSkewed = clampReplicaView(view({ a: now + 2 * 60_000 }), now);
    expect(planMerge(local, remoteSkewed).applyRemote).toEqual(['a']);
  });

  it('clamps a runaway clock so a later genuine edit can win again', () => {
    const yearAhead = now + 365 * 24 * 3_600_000;
    const remote = clampReplicaView(view({ a: yearAhead }, { b: yearAhead }), now);
    expect(remote).toEqual(view({ a: now + MAX_FUTURE_SKEW_MS }, { b: now + MAX_FUTURE_SKEW_MS }));
    // Two days later the user edits `a` on a sane device: their edit outranks
    // the clamped stamp instead of losing until next year.
    const later = now + 2 * 24 * 3_600_000;
    const local = view({ a: later });
    expect(planMerge(local, remote).pushLocal).toEqual(['a']);
  });

  it('collapses junk stamps to 0, which then lose every merge', () => {
    const remote = clampReplicaView(view({ a: NaN }), now);
    expect(remote).toEqual(view({ a: 0 }));
    expect(planMerge(view({ a: 100 }), remote).pushLocal).toEqual(['a']);
  });
});
