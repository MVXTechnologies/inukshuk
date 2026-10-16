/**
 * The room client (G6) against an in-memory Worker: signed entry, sealed
 * blobs only, a hostile relay's tampering and replays dropped, TURN through
 * the admitted socket, reconnect with backoff, and the R-META-4 jitter and
 * idle close. Manual queue, clock and timers (the G5 rig).
 */
import { deriveRoom, groupRooms, type Room } from '@core/group/rdv';
import { toB64u, utf8, utf8Decode } from '@core/team/bytes';
import { nodeCrypto as c } from '@core/team/testing/nodeCrypto';

import {
  ROOM_BACKOFF_MS,
  ROOM_IDLE_MS,
  ROOM_IDLE_RETRY_MS,
  RoomClient,
  TURN_TIMEOUT_MS,
  type RoomEvent,
  type TurnReply,
} from './roomClient';
import { FakeRoomServer } from './testing/fakeRoom';
import { Rig } from './testing/rig';

const HOST = 'rtc.example.net';
const GROUP = toB64u(new Uint8Array(16).fill(3));

function setup() {
  const rig = new Rig({ pacingHorizonMs: 1_000 });
  const server = new FakeRoomServer(c, HOST, (fn) => rig.hub.schedule(fn), rig.now);
  const room = groupRooms(
    c,
    { groupId: GROUP, epochKey: new Uint8Array(32).fill(9) },
    rig.t / 1000,
  )[0]!;
  const client = (r: Room = room, jitterMs = 0, random?: () => number) => {
    const events: RoomEvent[] = [];
    const rc = new RoomClient({
      c,
      host: HOST,
      room: r,
      ws: server.factory,
      now: rig.now,
      timers: rig.timers,
      jitterMs,
      ...(random ? { random } : {}),
      onEvent: (e) => events.push(e),
    });
    return { rc, events };
  };
  return { rig, server, room, client };
}

const messages = (events: RoomEvent[]) =>
  events.flatMap((e) => (e.type === 'message' ? [utf8Decode(e.payload)] : []));

describe('RoomClient', () => {
  it('enters by signing the challenge, sees the others, and exchanges sealed blobs', async () => {
    const { rig, server, room, client } = setup();
    const a = client();
    const b = client();
    a.rc.start();
    await rig.settle();
    b.rc.start();
    await rig.settle();
    expect(a.rc.state).toBe('ready');
    expect(b.rc.state).toBe('ready');
    expect(server.members(room.roomId)).toBe(2);
    expect(a.events.map((e) => e.type)).toEqual(['ready', 'join']);
    expect(b.events[0]).toEqual({ type: 'ready', me: b.rc.me, peers: [a.rc.me] });

    expect(a.rc.send(b.rc.me!, utf8('hi1 from a'))).toBe(true);
    expect(b.rc.send(a.rc.me!, utf8('hi2 from b'))).toBe(true);
    await rig.settle();
    expect(messages(b.events)).toEqual(['hi1 from a']);
    expect(messages(a.events)).toEqual(['hi2 from b']);
    // The relay saw entries and opaque messages, nothing else.
    expect(new Set(server.seen)).toEqual(new Set(['auth', 'm']));
    // Not to a stranger, not oversized.
    expect(a.rc.send(toB64u(new Uint8Array(8).fill(9)), utf8('x'))).toBe(false);
    expect(a.rc.send(b.rc.me!, new Uint8Array(20_000))).toBe(false);

    const bMe = b.rc.me!;
    b.rc.stop();
    await rig.settle();
    expect(a.events.at(-1)).toEqual({ type: 'leave', h: bMe });
    expect(server.members(room.roomId)).toBe(1);
  });

  it('cannot enter a room whose key it does not hold (retries with backoff)', async () => {
    const { rig, server, room, client } = setup();
    const stranger = client({
      ...deriveRoom(c, new Uint8Array(32).fill(1), room.day),
      roomId: room.roomId,
    });
    stranger.rc.start();
    await rig.settle();
    expect(stranger.rc.state).not.toBe('ready');
    expect(server.members(room.roomId)).toBe(0);
    stranger.rc.stop();
  });

  it('drops what a hostile relay tampers with or replays', async () => {
    const { rig, server, client } = setup();
    const a = client();
    const b = client();
    a.rc.start();
    b.rc.start();
    await rig.settle();
    server.tamper = true;
    a.rc.send(b.rc.me!, utf8('tampered'));
    await rig.settle();
    expect(messages(b.events)).toEqual([]);
    server.tamper = false;
    server.replay = true;
    a.rc.send(b.rc.me!, utf8('once'));
    await rig.settle();
    expect(messages(b.events)).toEqual(['once']);
  });

  it('gets TURN credentials through the admitted socket, or says why not', async () => {
    const { rig, server, client } = setup();
    const a = client();
    a.rc.start();
    await rig.settle();
    const ask = async (): Promise<TurnReply> => {
      const p = a.rc.requestTurn();
      await rig.settle();
      return p;
    };
    expect(await ask()).toEqual({ error: 'alone' });
    const b = client();
    b.rc.start();
    await rig.settle();
    const ok = await ask();
    expect(ok).toMatchObject({ ttlS: 900 });
    expect('ice' in ok && ok.ice.some((s) => s.username !== undefined)).toBe(true);
    server.turn = 'budget';
    expect(await ask()).toEqual({ error: 'budget' });
    server.turn = 'silent';
    const pending = a.rc.requestTurn();
    rig.advance(TURN_TIMEOUT_MS + 1);
    await rig.settle();
    expect(await pending).toEqual({ error: 'timeout' });
    a.rc.stop();
    expect(await a.rc.requestTurn()).toEqual({ error: 'closed' });
  });

  it('comes back after the relay drops it, waiting longer after each failure', async () => {
    const { rig, server, room, client } = setup();
    const a = client();
    const b = client();
    a.rc.start();
    b.rc.start();
    await rig.settle();
    server.down = true;
    server.dropAll();
    await rig.settle();
    expect(a.events.some((e) => e.type === 'down')).toBe(true);
    expect(a.rc.state).toBe('waiting');
    rig.advance(ROOM_BACKOFF_MS);
    await rig.settle();
    expect(a.rc.state).toBe('waiting'); // refused again: the wait doubles
    server.down = false;
    rig.advance(ROOM_BACKOFF_MS);
    await rig.settle();
    expect(a.rc.state).toBe('waiting');
    rig.advance(ROOM_BACKOFF_MS);
    await rig.settle();
    expect(a.rc.state).toBe('ready');
    expect(server.members(room.roomId)).toBeGreaterThanOrEqual(1);
  });

  it('waits a random 0–30 s before connecting, and closes when alone for 10 min (R-META-4)', async () => {
    const { rig, server, room, client } = setup();
    const a = client(room, 30_000, () => 0.5);
    a.rc.start();
    await rig.settle();
    expect(a.rc.state).toBe('waiting');
    rig.advance(14_000);
    await rig.settle();
    expect(server.members(room.roomId)).toBe(0);
    rig.advance(1_000);
    await rig.settle();
    expect(a.rc.state).toBe('ready');
    rig.advance(ROOM_IDLE_MS);
    await rig.settle();
    expect(server.members(room.roomId)).toBe(0);
    expect(a.events.at(-1)).toEqual({ type: 'down', reason: 'idle' });
    rig.advance(ROOM_IDLE_RETRY_MS + 15_000);
    await rig.settle();
    expect(a.rc.state).toBe('ready');
    a.rc.stop();
    await rig.settle();
    rig.advance(ROOM_IDLE_RETRY_MS * 4);
    await rig.settle();
    expect(server.members(room.roomId)).toBe(0);
  });
});
