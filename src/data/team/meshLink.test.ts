import { LoopbackMeshHub, type LoopbackMeshTransport } from './loopbackMesh';
import { defaultRetryDelayMs, MeshLink } from './meshLink';

/** A hub whose deliveries run when `run()` is called (no real timers involved). */
function manualHub() {
  const queue: (() => void)[] = [];
  const hub = new LoopbackMeshHub({ schedule: (fn) => queue.push(fn) });
  const run = (): void => {
    for (let fn = queue.shift(); fn; fn = queue.shift()) fn();
  };
  return { hub, run };
}

/** A teammate's phone that advertises the tag and hangs up on every caller. */
async function hangingUpTeammate(hub: LoopbackMeshHub, tag: string) {
  const t = hub.createTransport();
  await t.start();
  await t.startAdvertising(tag);
  t.subscribe((e) => {
    if (e.type === 'connected') t.disconnect(e.peer.peerId);
  });
  return t;
}

async function joiner(hub: LoopbackMeshHub, run: () => void) {
  const t: LoopbackMeshTransport = hub.createTransport();
  const dials = jest.spyOn(t, 'connectService');
  const diag: string[] = [];
  const link = new MeshLink(t, {
    tag: 'team-tag',
    advertise: false,
    oneAtATime: true,
    onChange: () => undefined,
    onDiag: (e) => diag.push(e),
  });
  await link.start();
  run();
  return { link, dials, diag };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('MeshLink, one at a time (a joiner)', () => {
  it('dials the only teammate in range again after a backoff when the session ends', async () => {
    const { hub, run } = manualHub();
    await hangingUpTeammate(hub, 'team-tag');
    const { link, dials, diag } = await joiner(hub, run);
    run();
    expect(dials).toHaveBeenCalledTimes(1);
    expect(diag).toContain('retry in 2000 ms');

    jest.advanceTimersByTime(1_999);
    expect(dials).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    run();
    expect(dials).toHaveBeenCalledTimes(2);
    // The next wait doubles.
    expect(diag).toContain('retry in 4000 ms');
    jest.advanceTimersByTime(4_000);
    run();
    expect(dials).toHaveBeenCalledTimes(3);
    await link.stop();
  });

  it('stops retrying once the link stops', async () => {
    const { hub, run } = manualHub();
    await hangingUpTeammate(hub, 'team-tag');
    const { link, dials } = await joiner(hub, run);
    run();
    expect(dials).toHaveBeenCalledTimes(1);
    await link.stop();
    jest.advanceTimersByTime(60_000);
    run();
    expect(dials).toHaveBeenCalledTimes(1);
  });

  it('tries each teammate once per round, then waits (never spins between refusals)', async () => {
    const { hub, run } = manualHub();
    await hangingUpTeammate(hub, 'team-tag');
    await hangingUpTeammate(hub, 'team-tag');
    const { link, dials } = await joiner(hub, run);
    run();
    // First phone hangs up, the second is dialled at once; then the round is over.
    expect(dials).toHaveBeenCalledTimes(2);
    expect(new Set(dials.mock.calls.map((c) => c[0])).size).toBe(2);
    jest.advanceTimersByTime(1_999);
    run();
    expect(dials).toHaveBeenCalledTimes(2);
    // After the backoff, the next round: both again, once each.
    jest.advanceTimersByTime(1);
    run();
    expect(dials).toHaveBeenCalledTimes(4);
    await link.stop();
  });

  it('backs off 2 s, 4 s, 8 s … up to 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(defaultRetryDelayMs)).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });
});
