import { asciiToBytes, bytesToAscii } from '@core/gnss/bytes';
import { newProfile, type NtripProfile } from '@core/gnss/config';
import { fixOf } from '@core/gnss/testUtils';
import type { NtripSocketFactory, NtripSocketHandlers } from '@data/gnss/ntripSocket';
import { ntripSocketFactory, SIMULATED_SOURCETABLE } from '@data/gnss/ntripSocket';
import type { NtripState } from '@state/gnssStore';

import {
  fetchSourcetable,
  ggaQuality,
  NO_SOCKET_MESSAGE,
  NTRIP_RETRY_MS,
  NtripClient,
  ntripRefusal,
} from './ntripClient';

/** A caster that answers with `reply` and records what it was sent. */
function caster(reply: string | null) {
  const sent: string[] = [];
  let handlers: NtripSocketHandlers | null = null;
  let opened = 0;
  const factory: NtripSocketFactory = {
    kind: 'simulated',
    open(_h, _p, _t, h) {
      opened += 1;
      handlers = h;
      return {
        async write(b) {
          sent.push(bytesToAscii(b));
          if (reply !== null && sent.length === 1) h.onData(asciiToBytes(reply));
        },
        close: jest.fn(),
      };
    },
  };
  return {
    factory,
    sent,
    get opened() {
      return opened;
    },
    data: (s: Uint8Array) => handlers?.onData(s),
    close: (err: string | null) => handlers?.onClose(err),
  };
}

const PROFILE: NtripProfile = {
  ...newProfile('p', 'rtk2go'),
  mountpoint: 'LEVIS',
  username: 'me@example.com',
};

function client(factory: NtripSocketFactory | null) {
  const states: NtripState[] = [];
  const received: Uint8Array[] = [];
  let now = 1_000_000;
  const c = new NtripClient({
    sockets: factory,
    toReceiver: async (b) => {
      received.push(b);
    },
    publish: (s) => states.push(s),
    now: () => now,
  });
  return {
    c,
    states,
    received,
    tickTo: (ms: number) => {
      now = ms;
    },
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('NtripClient', () => {
  it('streams RTCM to the receiver after ICY 200 OK', async () => {
    const k = caster('ICY 200 OK\r\n\r\n');
    const { c, states, received } = client(k.factory);
    c.start(PROFILE, 'none', null);
    await Promise.resolve();
    expect(k.sent[0]).toMatch(/^GET \/LEVIS HTTP\/1.0\r\n/);
    expect(states.at(-1)?.phase).toBe('streaming');
    k.data(new Uint8Array([0xd3, 0, 1, 2]));
    expect(received).toHaveLength(1);
    c.stop();
    expect(states.at(-1)).toEqual({ phase: 'off', message: null, bytes: 0, lastDataAtMs: null });
  });

  it('a refusal is shown in words and not retried', async () => {
    const k = caster('HTTP/1.1 401 Unauthorized\r\n\r\n');
    const { c, states } = client(k.factory);
    c.start({ ...PROFILE, version: 2 }, 'wrong', null);
    await Promise.resolve();
    expect(states.at(-1)).toMatchObject({
      phase: 'error',
      message: 'The caster refused the user name or password',
    });
    jest.advanceTimersByTime(NTRIP_RETRY_MS * 2);
    expect(k.opened).toBe(1);
  });

  it('a dropped stream is retried after NTRIP_RETRY_MS', async () => {
    const k = caster('ICY 200 OK\r\n\r\n');
    const { c, states } = client(k.factory);
    c.start(PROFILE, 'none', null);
    await Promise.resolve();
    k.close('ECONNRESET');
    expect(states.at(-1)).toMatchObject({ phase: 'error', message: 'ECONNRESET' });
    jest.advanceTimersByTime(NTRIP_RETRY_MS);
    expect(k.opened).toBe(2);
    k.close(null);
    expect(states.at(-1)?.message).toBe('The caster closed the connection');
    c.stop();
  });

  it('uploads GGA every 10 s only to a caster that needs it, with consent', async () => {
    const k = caster('ICY 200 OK\r\n\r\n');
    const { c, tickTo } = client(k.factory);
    const vrs = { ...PROFILE, needsGga: true, ggaConsent: true };
    c.start(vrs, 'none', fixOf('rtk-float'));
    await Promise.resolve();
    c.tick(fixOf('rtk-float'));
    expect(k.sent[1]).toMatch(/^\$GPGGA,.*,5,14,0\.8,/);
    tickTo(1_005_000);
    c.tick(fixOf('rtk-float'));
    expect(k.sent).toHaveLength(2);
    tickTo(1_010_000);
    c.tick(null);
    expect(k.sent).toHaveLength(2);
    c.tick(fixOf('rtk-float'));
    expect(k.sent).toHaveLength(3);
    c.stop();
    // Without consent: never.
    const k2 = caster('ICY 200 OK\r\n\r\n');
    const n = client(k2.factory);
    n.c.start({ ...vrs, ggaConsent: false }, 'none', null);
    await Promise.resolve();
    n.c.tick(fixOf('rtk-float'));
    expect(k2.sent).toHaveLength(1);
  });

  it('NTRIP 2 VRS: the position rides in the request when allowed', async () => {
    const k = caster(null);
    const { c } = client(k.factory);
    c.start({ ...PROFILE, version: 2, needsGga: true, ggaConsent: true }, 'pw', fixOf('dgps'));
    await Promise.resolve();
    expect(k.sent[0]).toMatch(/Ntrip-GGA: \$GPGGA/);
    expect(k.sent[0]).toMatch(/Authorization: Basic /);
  });

  it('no socket in this build: says it needs an update; bad settings: says what', () => {
    const none = client(null);
    none.c.start(PROFILE, '', null);
    expect(none.states.at(-1)).toMatchObject({ phase: 'unavailable', message: NO_SOCKET_MESSAGE });
    const bad = client(caster(null).factory);
    bad.c.start({ ...PROFILE, username: 'a:b' }, '', null);
    expect(bad.states.at(-1)).toMatchObject({ phase: 'error' });
    expect(bad.states.at(-1)?.message).toMatch(/":"/);
  });

  it('words and GGA qualities', () => {
    expect(ntripRefusal('not-found', 'X')).toBe('The caster has no mountpoint “X”');
    expect(ntripRefusal('sourcetable', 'X')).toBe('The caster has no mountpoint “X”');
    expect(ntripRefusal('bad-response', 'X')).toMatch(/NTRIP caster/);
    expect(ntripRefusal('error', 'X')).toMatch(/error/);
    expect(
      (['rtk-fixed', 'rtk-float', 'dgps', 'sbas', 'autonomous', 'none'] as const).map(ggaQuality),
    ).toEqual([4, 5, 2, 2, 1, 0]);
  });
});

describe('fetchSourcetable', () => {
  it('reads the simulated caster’s mountpoints', async () => {
    const p = fetchSourcetable(ntripSocketFactory(), PROFILE, '');
    jest.advanceTimersByTime(300);
    const table = await p;
    expect(table.streams.map((s) => s.mountpoint)).toEqual([
      'SIM_LEVIS',
      'SIM_BEAUPORT',
      'SIM_NETWORK',
      'SIM_CMR',
    ]);
    expect(table.streams[2]?.nmea).toBe(true);
    expect(SIMULATED_SOURCETABLE).toMatch(/ENDSOURCETABLE/);
  });

  it('refusals and silence become sentences', async () => {
    await expect(fetchSourcetable(null, PROFILE, '')).rejects.toThrow(NO_SOCKET_MESSAGE);
    await expect(
      fetchSourcetable(caster('HTTP/1.1 401 Unauthorized\r\n\r\n').factory, PROFILE, ''),
    ).rejects.toThrow(/refused/);
    await expect(
      fetchSourcetable(caster('ICY 200 OK\r\n\r\n').factory, PROFILE, ''),
    ).rejects.toThrow(/list of mountpoints/);
    await expect(
      fetchSourcetable(caster(null).factory, { ...PROFILE, host: 'bad host' }, ''),
    ).rejects.toThrow(/host/);
    const silent = fetchSourcetable(caster(null).factory, PROFILE, '');
    jest.advanceTimersByTime(20_000);
    await expect(silent).rejects.toThrow(/did not answer/);
    await expect(
      fetchSourcetable(caster('SOURCETABLE 200 OK\r\n\r\nENDSOURCETABLE\r\n').factory, PROFILE, ''),
    ).rejects.toThrow(/no mountpoints/);
  });
});
