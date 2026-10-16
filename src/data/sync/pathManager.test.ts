/**
 * Internet paths end to end (G6), on the rig with an in-memory relay Worker
 * and an in-memory WebRTC: two real phones of one team, the LAN stopped.
 *
 * - nothing touches the internet until the team's `net` switch is on;
 * - direct first; when the NATs block it, TURN through the room, then relay;
 *   "Always use the relay" skips direct;
 * - nearby wins once it has proved itself, the internet path closes, and
 *   comes back when the LAN goes;
 * - an SOS goes out on every live link while two are up;
 * - a banned member gets no ICE; going offline closes everything.
 */
import { NET } from '@core/group/meta';
import type { IceServer } from '@core/group/roomProto';
import { nodeCrypto } from '@core/team/testing/nodeCrypto';
import { DEFAULT_INVITE, parseAnyInvite, webJoinLink } from '@core/teamui/invites';
import { lifetimeMs } from '@core/teamui/lifetime';

import { MemoryTeamDisk } from '@data/team/teamDisk';
import { TeamService } from '@data/team/teamService';
import type { CreatedInvite, TeamSession } from '@data/team/teamSession';

import { FakeRoomServer } from './testing/fakeRoom';
import { FakeRtcNetwork } from './testing/fakeRtc';
import { Rig } from './testing/rig';

jest.mock('@lib/errorReporting', () => ({ addBreadcrumb: jest.fn(), reportError: jest.fn() }));

const HOST = 'rtc.example.net';
const STUN: IceServer[] = [{ urls: ['stun:stun.example.net:3478'] }];

function world() {
  const rig = new Rig({ pacingHorizonMs: 1_000 });
  const schedule = (fn: () => void) => rig.hub.schedule(fn);
  const server = new FakeRoomServer(nodeCrypto, HOST, schedule, rig.now);
  const rtc = new FakeRtcNetwork(schedule);
  const phone = () =>
    new TeamService({
      c: nodeCrypto,
      disk: new MemoryTeamDisk(),
      transport: rig.hub.createTransport(),
      now: rig.now,
      tickMs: 5_000,
      timers: rig.timers,
      internet: { host: HOST, ws: server.factory, rtc: rtc.module, stun: STUN, jitterMs: 0 },
    });
  /** Let time pass in small steps, running what each step wakes. */
  const run = async (ms: number, step = 500) => {
    for (let t = 0; t < ms; t += step) {
      rig.advance(step);
      await rig.settle();
    }
  };
  return { rig, server, rtc, phone, run };
}

const active = (p: TeamService): TeamSession => p.active!;

function setNet(p: TeamService, on: boolean, now: number): void {
  const s = active(p);
  s.store.track(() => ({
    result: s.replica.write(now, 'e.set', { k: NET, id: 'g', f: { inet: on ? 1 : 0 } }),
    accepted: [],
  }));
}

/** Marc and Julie in one team, joined on the LAN, then apart (LAN stopped). */
async function pair(w: ReturnType<typeof world>, net = true) {
  const { rig } = w;
  const a = w.phone();
  const b = w.phone();
  await a.createTeam({ name: 'Remote', myName: 'Marc', lifetimeMs: lifetimeMs('14d') });
  await active(a).startMesh();
  const inv = active(a).createInvite(DEFAULT_INVITE) as CreatedInvite;
  await b.startJoin(parseAnyInvite(webJoinLink(inv.payload))!, 'Julie');
  await rig.settle();
  const joined = await b.confirmJoin();
  if (typeof joined === 'string') throw new Error(joined);
  joined.watchFirstLinkMs = 0;
  await active(b).startMesh();
  await rig.settle();
  if (net) setNet(a, true, rig.now());
  await rig.settle();
  await active(a).stopMesh();
  await active(b).stopMesh();
  await rig.settle();
  return { a, b };
}

const paths = (p: TeamService) =>
  p.host
    .links()
    .map((l) => l.path)
    .sort();

const messages = (p: TeamService) =>
  active(p)
    .view()
    .messages.map((m) => m.text);

async function online(w: ReturnType<typeof world>, ...ps: TeamService[]) {
  for (const p of ps) p.host.setInternetOnline(true);
  await w.rig.settle();
  await w.run(3_000);
}

describe('PathManager: internet paths (G6)', () => {
  it('stays off the internet until the team’s switch is on', async () => {
    const w = world();
    const { a, b } = await pair(w, false);
    expect(a.host.internetCapable).toBe(true);
    await online(w, a, b);
    expect(w.server.rooms()).toEqual([]);
    expect(w.rtc.pcs).toEqual([]);
    expect(paths(a)).toEqual([]);
    // The admin turns it on (here on the LAN); both phones enter the room.
    await active(a).startMesh();
    await active(b).startMesh();
    await w.rig.settle();
    setNet(a, true, w.rig.now());
    await w.rig.settle();
    await active(a).stopMesh();
    await active(b).stopMesh();
    await w.run(3_000);
    expect(w.server.rooms()).toHaveLength(1);
    expect(paths(a)).toEqual(['direct']);
  });

  it('connects directly, syncs over it, and the relay saw only opaque blobs', async () => {
    const w = world();
    const { a, b } = await pair(w);
    await online(w, a, b);
    expect(paths(a)).toEqual(['direct']);
    expect(paths(b)).toEqual(['direct']);
    expect(a.host.internetStatus()).toEqual([
      expect.objectContaining({ member: active(b).me, primary: 'direct', signalling: true }),
    ]);
    expect(active(b).sendMessage('From the summit')).toBeNull();
    await w.run(1_000);
    expect(messages(a)).toContain('From the summit');
    expect(new Set(w.server.seen)).toEqual(new Set(['auth', 'm']));
    expect(w.server.turnMints).toBe(0);
    // R-RTC-3: no private address crossed.
    expect(w.rtc.remoteCandidates.some((c) => c.includes('typ host'))).toBe(false);
  });

  it('falls back to TURN when the NATs block direct, minting credentials through the room', async () => {
    const w = world();
    w.rtc.directWorks = false;
    const { a, b } = await pair(w);
    await online(w, a, b);
    expect(paths(a)).toEqual([]);
    await w.run(10_000); // the 8 s direct deadline, then TURN
    expect(w.server.turnMints).toBeGreaterThan(0);
    expect(paths(a)).toEqual(['relay']);
    expect(paths(b)).toEqual(['relay']);
    expect(a.host.internetStatus()[0]).toMatchObject({ primary: 'relay' });
    expect(active(a).sendMessage('Via the relay')).toBeNull();
    await w.run(1_000);
    expect(messages(b)).toContain('Via the relay');
  });

  it('while relayed, retries direct every 5 min and moves to it once it holds', async () => {
    const w = world();
    w.rtc.directWorks = false;
    const { a, b } = await pair(w);
    await online(w, a, b);
    await w.run(10_000);
    expect(paths(a)).toEqual(['relay']);
    // The NAT changes (another network): direct now works.
    w.rtc.directWorks = true;
    await w.run(5 * 60_000, 5_000);
    await w.run(15_000);
    expect(paths(a)).toEqual(['direct']);
    expect(paths(b)).toEqual(['direct']);
  });

  it('without TURN credentials (relay budget spent) there is no path, and nothing loops', async () => {
    const w = world();
    w.rtc.directWorks = false;
    w.server.turn = 'budget';
    const { a, b } = await pair(w);
    await online(w, a, b);
    await w.run(30_000);
    expect(paths(a)).toEqual([]);
    const pcs = w.rtc.pcs.length;
    await w.run(60_000, 2_000);
    // At most one more direct try per 5 min; no relay dial without credentials.
    expect(w.rtc.pcs.length - pcs).toBeLessThanOrEqual(1);
    expect(a.host.internetStatus()[0]).toMatchObject({ signalling: true });
  });

  it('"Always use the relay" never tries direct', async () => {
    const w = world();
    const { a, b } = await pair(w);
    a.host.setAlwaysRelay(true);
    b.host.setAlwaysRelay(true);
    await online(w, a, b);
    expect(paths(a)).toEqual(['relay']);
    expect(w.rtc.pcs.every((p) => p.config.iceTransportPolicy === 'relay')).toBe(true);
    expect(w.rtc.remoteCandidates.some((c) => c.includes('typ srflx'))).toBe(false);
  });

  it('prefers nearby once it proved itself, sends an SOS on both meanwhile, and fails over back', async () => {
    const w = world();
    const { a, b } = await pair(w);
    await online(w, a, b);
    expect(paths(a)).toEqual(['direct']);
    // Back on the same Wi-Fi: the LAN link comes up next to the internet one.
    await active(a).startMesh();
    await active(b).startMesh();
    await w.rig.settle();
    expect(paths(a)).toEqual(['direct', 'nearby']);
    // An SOS meanwhile goes out on both live links (lane 0).
    const before = a.host.links().map((l) => [l.path, l.sentByLane[0]!] as const);
    expect(active(a).raiseSos(-71.2, 46.8)).toBeNull();
    await w.rig.settle();
    for (const l of a.host.links()) {
      expect(l.sentByLane[0]!).toBeGreaterThan(before.find(([p]) => p === l.path)![1]);
    }
    // Nearby has proved itself for 10 s: the internet path closes.
    await w.run(12_000);
    expect(paths(a)).toEqual(['nearby']);
    expect(paths(b)).toEqual(['nearby']);
    expect(a.host.internetStatus()[0]).toMatchObject({ primary: 'nearby' });
    // The LAN goes: back to the internet.
    await active(a).stopMesh();
    await active(b).stopMesh();
    await w.run(4_000);
    expect(paths(a)).toEqual(['direct']);
    expect(active(b).soses()).toHaveLength(1);
  });

  it('gives a banned member no ICE, and going offline closes every internet path', async () => {
    const w = world();
    const { a, b } = await pair(w);
    a.host.linkLayer!.memberBans.ban(active(b).me, w.rig.now() + 3_600_000);
    await online(w, a, b);
    await w.run(20_000);
    // Marc's phone never answered nor sent a candidate, and no path formed.
    expect(w.rtc.remoteCandidates).toEqual([]);
    expect(w.rtc.pcs.some((pc) => pc.connectionState === 'connected')).toBe(false);
    expect(paths(a)).toEqual([]);
    expect(paths(b)).toEqual([]);

    const w2 = world();
    const p = await pair(w2);
    await online(w2, p.a, p.b);
    expect(paths(p.a)).toEqual(['direct']);
    p.a.host.setInternetOnline(false);
    await w2.rig.settle();
    expect(paths(p.a)).toEqual([]);
    expect(paths(p.b)).toEqual([]);
    expect(w2.server.rooms()).toEqual([expect.any(String)]); // only B is left in the room
  });
});
