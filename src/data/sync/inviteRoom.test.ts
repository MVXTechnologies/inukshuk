/**
 * Joining over the internet (G7, security review §2.4.3) on the rig with the
 * in-memory relay and WebRTC, no LAN between the two phones:
 *
 * - the admin's invite writes its room (irdv); the joiner finds the team there,
 *   is admitted and catches up through sealed room blobs;
 * - without a compared code the join is provisional (R-INV-4): no position,
 *   relay-only paths, until another member vouches;
 * - a removal cancels the invites made before it (R-INV-3).
 */
import { inviteOpen, inviteRooms } from '@core/group/invites';
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
  const run = async (ms: number, step = 500) => {
    for (let t = 0; t < ms; t += step) {
      rig.advance(step);
      await rig.settle();
    }
  };
  return { rig, server, rtc, phone, run };
}

const active = (p: TeamService): TeamSession => p.active!;
const paths = (p: TeamService) =>
  p.host
    .links()
    .map((l) => l.path)
    .sort();

/** Marc founds a team (internet on) and invites; Julie joins from afar. */
async function joinFromAfar(w: ReturnType<typeof world>, compared: boolean) {
  const a = w.phone();
  await a.createTeam({ name: 'Chic-Chocs', myName: 'Marc', lifetimeMs: lifetimeMs('14d') });
  const inv = active(a).createInvite(DEFAULT_INVITE) as CreatedInvite;
  a.host.setInternetOnline(true);
  await w.run(3_000);
  const b = w.phone();
  const attempt = await b.startJoin(parseAnyInvite(webJoinLink(inv.payload))!, 'Julie');
  await w.run(8_000);
  expect(attempt.state()).toMatchObject({ phase: 'verify', via: 'internet', internet: true });
  const joined = await b.confirmJoin(compared);
  if (typeof joined === 'string') throw new Error(joined);
  joined.watchFirstLinkMs = 0;
  b.host.setInternetOnline(true);
  await w.run(15_000);
  return { a, b, inv };
}

describe('joining over the internet (G7)', () => {
  it('finds the team in the invite’s room, with no network in common', async () => {
    const w = world();
    const { a, b } = await joinFromAfar(w, true);
    expect(
      active(b)
        .view()
        .members.map((m) => m.name)
        .sort(),
    ).toEqual(['Julie', 'Marc']);
    expect(active(b).internetOn).toBe(true);
    expect(active(b).provisional).toBe(false);
    // Then over a WebRTC link, as any two members.
    expect(paths(a)).toEqual(['direct']);
    expect(active(b).sendMessage('Hello from Gaspé')).toBeNull();
    await w.run(1_000);
    expect(
      active(a)
        .view()
        .messages.map((m) => m.text),
    ).toContain('Hello from Gaspé');
  });

  it('without the code compared: provisional, relay only, no position (R-INV-4)', async () => {
    const w = world();
    const { a, b } = await joinFromAfar(w, false);
    expect(active(b).provisional).toBe(true);
    // The only path is the relay: the admitting phone never learns Julie's IP.
    expect(paths(b)).toEqual(['relay']);
    // Every WebRTC pair has Julie's end TURN-only (she never offers a public address).
    expect(
      w.rtc.pcs.every(
        (p) =>
          p.config.iceTransportPolicy === 'relay' || p.peer?.config.iceTransportPolicy === 'relay',
      ),
    ).toBe(true);
    // Sharing on, still nothing goes out.
    active(b).updateRecord({ prefs: { ...active(b).record.prefs, sharePosition: true } });
    expect(
      active(b).sharePosition({ latitude: 48.9, longitude: -66.1, at: w.rig.now() }),
    ).toBeNull();
    await w.run(1_000);
    expect(active(a).positions()).toEqual([]);
  });

  it('a removal cancels the invites made before it (R-INV-3)', async () => {
    const w = world();
    const { a, b } = await joinFromAfar(w, true);
    const pending = active(a).createInvite(DEFAULT_INVITE) as CreatedInvite;
    expect(pending.token).toBeDefined();
    const now = () => w.rig.now();
    expect(inviteRooms(active(a).replica.data(now()), active(a).replica.state, now())).toHaveLength(
      1,
    );
    expect(active(a).removeMember(active(b).me)).toBeNull();
    expect(active(a).revokedNotice).toMatchObject({ count: 1, name: 'Julie' });
    expect(inviteRooms(active(a).replica.data(now()), active(a).replica.state, now())).toEqual([]);
    const open = [...active(a).replica.state.invites.values()].filter((i) => inviteOpen(i, now()));
    expect(open).toEqual([]);
  });
});
