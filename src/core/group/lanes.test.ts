import { forAll, int } from '../team/testing/prop';
import {
  isLane,
  LANE_BULK,
  LANE_LIVE,
  LANE_SYNC,
  LANE_URGENT,
  LANES,
  LaneScheduler,
  laneOfOp,
  laneOfWrite,
  type Lane,
} from './lanes';

const op = (t: string, pr?: 1 | 2) =>
  ({ env: { t, ...(pr === undefined ? {} : { pr }) } }) as unknown as Parameters<
    typeof laneOfOp
  >[0];

describe('lane classification (design §4.4)', () => {
  it('puts removals, rotations, revocations, SOS, rally and pr:2 on lane 0', () => {
    expect(laneOfWrite({ type: 'k.rotate' })).toBe(LANE_URGENT);
    expect(laneOfWrite({ type: 'm.remove' })).toBe(LANE_URGENT);
    expect(laneOfWrite({ type: 'i.revoke' })).toBe(LANE_URGENT);
    expect(laneOfWrite({ type: 'e.set', kind: 'sos' })).toBe(LANE_URGENT);
    expect(laneOfWrite({ type: 'e.del', kind: 'rly' })).toBe(LANE_URGENT);
    expect(laneOfWrite({ type: 'msg', pr: 2 })).toBe(LANE_URGENT);
  });

  it('puts everything else pushed live on lane 1', () => {
    expect(laneOfWrite({ type: 'e.set', kind: 'wpt' })).toBe(LANE_LIVE);
    expect(laneOfWrite({ type: 'e.set' })).toBe(LANE_LIVE);
    expect(laneOfWrite({ type: 'msg', kind: 'sos' })).toBe(LANE_LIVE);
    expect(laneOfWrite({ type: 'msg', pr: 1 })).toBe(LANE_LIVE);
    expect(laneOfWrite({ type: 'pos' })).toBe(LANE_LIVE);
    expect(laneOfWrite({ type: 'm.add' })).toBe(LANE_LIVE);
  });

  it('reads what the envelope shows in clear, raised by the writer hint', () => {
    expect(laneOfOp(op('k.rotate'))).toBe(LANE_URGENT);
    expect(laneOfOp(op('msg', 2))).toBe(LANE_URGENT);
    expect(laneOfOp(op('e.set'))).toBe(LANE_LIVE);
    expect(laneOfOp(op('e.set'), LANE_URGENT)).toBe(LANE_URGENT);
    // A hint never lowers what the envelope says.
    expect(laneOfOp(op('m.remove'), LANE_SYNC)).toBe(LANE_URGENT);
    expect(laneOfOp(op('pos'), LANE_SYNC)).toBe(LANE_LIVE);
  });

  it('recognises lanes', () => {
    for (const l of LANES) expect(isLane(l)).toBe(true);
    for (const x of [-1, 4, 1.5, '1', undefined, null]) expect(isLane(x)).toBe(false);
  });
});

describe('LaneScheduler', () => {
  const pendingOf = (q: number[]) => (l: Lane) => q[l]! > 0;

  function serve(s: LaneScheduler, q: number[], frames: number): Lane[] {
    const out: Lane[] = [];
    for (let i = 0; i < frames; i++) {
      const lane = s.pick(pendingOf(q));
      if (lane === undefined) break;
      q[lane] = q[lane]! - 1;
      s.served(lane, pendingOf(q));
      out.push(lane);
    }
    return out;
  }

  it('serves nothing when nothing is pending', () => {
    expect(new LaneScheduler().pick(() => false)).toBeUndefined();
  });

  it('is strict priority while the quantum is not reached', () => {
    const s = new LaneScheduler(16);
    expect(serve(s, [2, 2, 2, 0], 6)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('gives bulk and sync one turn per quantum, never ahead of lane 0', () => {
    const s = new LaneScheduler(4);
    const q = [0, 100, 0, 10];
    const order = serve(s, q, 10);
    expect(order).toEqual([1, 1, 1, 1, 3, 1, 1, 1, 1, 3]);
    // An urgent frame arriving while bulk is owed its turn still goes first.
    const s2 = new LaneScheduler(2);
    const q2 = [0, 10, 0, 10];
    serve(s2, q2, 2);
    q2[0] = 1;
    expect(s2.pick(pendingOf(q2))).toBe(LANE_URGENT);
  });

  it('property: a pending lane-0 frame is always picked first', () => {
    forAll(
      705,
      300,
      (rnd) => ({
        quantum: int(rnd, 1, 8),
        q: [int(rnd, 0, 3), int(rnd, 0, 30), int(rnd, 0, 30), int(rnd, 0, 30)],
        warm: int(rnd, 0, 40),
      }),
      ({ quantum, q, warm }) => {
        const s = new LaneScheduler(quantum);
        serve(s, q, warm);
        q[0] = 1;
        expect(s.pick(pendingOf(q))).toBe(LANE_URGENT);
      },
    );
  });

  it('property: bulk is never starved longer than the quantum', () => {
    forAll(
      706,
      200,
      (rnd) => ({ quantum: int(rnd, 1, 10), live: int(rnd, 20, 200) }),
      ({ quantum, live }) => {
        const s = new LaneScheduler(quantum);
        const q = [0, live, live, 5];
        const order = serve(s, q, live);
        let gap = 0;
        for (const lane of order) {
          if (lane === LANE_BULK) gap = 0;
          else gap++;
          expect(gap).toBeLessThanOrEqual(quantum + 1);
          if (q[LANE_BULK] === 0) break;
        }
      },
    );
  });
});
