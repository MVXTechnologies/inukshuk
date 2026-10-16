import { asciiToBytes, bytesToAscii } from '@core/gnss/bytes';
import { newProfile, type NtripProfile } from '@core/gnss/config';
import { FakeCaster, fixOf, type CasterDialect } from '@core/gnss/testUtils';
import type { NtripSocketFactory, NtripSocketHandlers } from '@data/gnss/ntripSocket';
import { ntripSocketFactory, SIMULATED_SOURCETABLE } from '@data/gnss/ntripSocket';
import type { NtripState } from '@state/gnssStore';

import {
  fetchSourcetable,
  GGA_BEFORE_REPLY_MS,
  ggaQuality,
  NO_SOCKET_MESSAGE,
  NTRIP_RETRY_MS,
  NtripClient,
  ntripRefusal,
  REFUSAL_READ_MS,
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

  it('uploads GGA every 10 s, only with consent', async () => {
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

  it('an HTTP 200 sourcetable labelled text/plain is still the list', async () => {
    const reply =
      'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nSTR;A;a;RTCM 3.2;;;GPS;;;;;;;;;B;;;\r\nENDSOURCETABLE\r\n';
    const table = await fetchSourcetable(caster(reply).factory, PROFILE, '');
    expect(table.streams.map((s) => s.mountpoint)).toEqual(['A']);
  });
});

/** A socket factory whose far end is a FakeCaster (byte-exact GR30 / strict v2 replies). */
function fakeCasterSockets(dialect: CasterDialect, opts: { waitForGga?: boolean } = {}) {
  const casters: FakeCaster[] = [];
  let handlers: NtripSocketHandlers | null = null;
  const factory: NtripSocketFactory = {
    kind: 'simulated',
    open(host, _p, _t, h) {
      expect(host).toBe('caster.example.invalid');
      const c = new FakeCaster({
        dialect,
        mountpoint: 'Quebec_RTCM3x',
        user: 'rover@example.org',
        pass: 's3cret',
        waitForGga: opts.waitForGga,
      });
      casters.push(c);
      handlers = h;
      return {
        async write(b) {
          const reply = c.receive(b);
          if (reply.length > 0) h.onData(reply);
        },
        close: jest.fn(),
      };
    },
  };
  const last = (): FakeCaster => {
    const c = casters.at(-1);
    if (!c) throw new Error('no connection');
    return c;
  };
  return {
    factory,
    casters,
    last,
    send: (rtcm: Uint8Array) => handlers?.onData(last().data(rtcm)),
    drop: (err: string | null) => handlers?.onClose(err),
  };
}

const GR30_PROFILE: NtripProfile = {
  ...newProfile('gr30', null),
  host: 'caster.example.invalid',
  port: 2103,
  version: 2,
  mountpoint: 'Quebec_RTCM3x',
  username: 'rover@example.org',
  // The GR30's sourcetable leaves the nmea field empty.
  needsGga: false,
  ggaConsent: true,
};

const RTCM = new Uint8Array([0xd3, 0x00, 0x02, 0x43, 0x50, 0x11, 0x22, 0x33]);

describe('against a fake Leica GR30 and a strict NTRIP 2 caster (#751)', () => {
  it.each(['gr30', 'gr30-icy-headers', 'v2'] as const)(
    '%s: NTRIP 2 profile streams; the position goes out at once and every 10 s',
    async (dialect) => {
      const k = fakeCasterSockets(dialect);
      const { c, states, received, tickTo } = client(k.factory);
      c.start(GR30_PROFILE, 's3cret', fixOf('autonomous'));
      await Promise.resolve();
      expect(k.last().request?.line).toBe('GET /Quebec_RTCM3x HTTP/1.1');
      expect(k.last().request?.headers['ntrip-version']).toBe('Ntrip/2.0');
      expect(k.last().request?.headers['ntrip-gga']).toMatch(/^\$GPGGA,/);
      expect(states.at(-1)?.phase).toBe('streaming');
      // in-band too: a v1 caster ignores the Ntrip-GGA header
      expect(k.last().ggas).toHaveLength(1);
      k.send(RTCM);
      k.send(RTCM);
      expect(received.flatMap((b) => [...b])).toEqual([...RTCM, ...RTCM]);
      tickTo(1_009_000);
      c.tick(fixOf('autonomous'));
      expect(k.last().ggas).toHaveLength(1);
      tickTo(1_010_000);
      c.tick(fixOf('rtk-float'));
      expect(k.last().ggas).toHaveLength(2);
      expect(k.last().ggas[1]).toMatch(/^\$GPGGA,[^*]*,5,14,0\.8,/);
      c.stop();
    },
  );

  it('an NTRIP 1 profile against the GR30 streams too', async () => {
    const k = fakeCasterSockets('gr30');
    const { c, states } = client(k.factory);
    c.start({ ...GR30_PROFILE, version: 1 }, 's3cret', null);
    await Promise.resolve();
    expect(k.last().request?.line).toBe('GET /Quebec_RTCM3x HTTP/1.0');
    expect(states.at(-1)?.phase).toBe('streaming');
    c.stop();
  });

  it('no consent: never a position, even to a caster that asks for one', async () => {
    const k = fakeCasterSockets('gr30');
    const { c, tickTo } = client(k.factory);
    c.start({ ...GR30_PROFILE, needsGga: true, ggaConsent: false }, 's3cret', fixOf('dgps'));
    await Promise.resolve();
    tickTo(1_100_000);
    c.tick(fixOf('dgps'));
    expect(k.last().request?.headers['ntrip-gga']).toBeUndefined();
    expect(k.last().ggas).toEqual([]);
    c.stop();
  });

  it('a caster that waits for a position before answering gets one after 2 s', async () => {
    const k = fakeCasterSockets('gr30', { waitForGga: true });
    const { c, states, tickTo } = client(k.factory);
    c.start({ ...GR30_PROFILE, version: 1 }, 's3cret', null);
    await Promise.resolve();
    expect(states.at(-1)?.phase).toBe('connecting');
    tickTo(1_001_000);
    c.tick(fixOf('autonomous'));
    expect(k.last().ggas).toHaveLength(0);
    tickTo(1_000_000 + GGA_BEFORE_REPLY_MS);
    c.tick(fixOf('autonomous'));
    await Promise.resolve();
    expect(k.last().ggas).toHaveLength(1);
    expect(states.at(-1)?.phase).toBe('streaming');
    c.stop();
  });

  it('an uppercased mountpoint: the error names the caster’s spelling', async () => {
    const k = fakeCasterSockets('gr30');
    const { c, states } = client(k.factory);
    c.start({ ...GR30_PROFILE, mountpoint: 'QUEBEC_RTCM3X' }, 's3cret', null);
    await Promise.resolve();
    expect(states.at(-1)).toMatchObject({
      phase: 'error',
      message:
        'The caster has no mountpoint “QUEBEC_RTCM3X” · it lists “Quebec_RTCM3x” (capitals matter)',
    });
    jest.advanceTimersByTime(NTRIP_RETRY_MS * 2);
    expect(k.casters).toHaveLength(1);
  });

  it('an unknown mountpoint whose sourcetable never ends, or closes early, is refused', async () => {
    const k = caster('SOURCETABLE 200 OK\r\n\r\nSTR;Other;');
    const { c, states } = client(k.factory);
    c.start(PROFILE, 'none', null);
    await Promise.resolve();
    expect(states.at(-1)?.phase).toBe('connecting');
    jest.advanceTimersByTime(REFUSAL_READ_MS);
    expect(states.at(-1)).toMatchObject({
      phase: 'error',
      message: 'The caster has no mountpoint “LEVIS”',
    });
    const k2 = caster('SOURCETABLE 200 OK\r\n\r\nSTR;levis;x;RTCM 3;;;;;;;;\r\n');
    const n = client(k2.factory);
    n.c.start(PROFILE, 'none', null);
    await Promise.resolve();
    k2.close(null);
    expect(n.states.at(-1)?.message).toBe(
      'The caster has no mountpoint “LEVIS” · it lists “levis” (capitals matter)',
    );
    jest.advanceTimersByTime(NTRIP_RETRY_MS * 2);
    expect(k2.opened).toBe(1);
  });

  it.each(['gr30', 'v2'] as const)('%s: a wrong password is refused, not retried', async (d) => {
    const k = fakeCasterSockets(d);
    const { c, states } = client(k.factory);
    c.start(GR30_PROFILE, 'wrong', null);
    await Promise.resolve();
    expect(states.at(-1)).toMatchObject({
      phase: 'error',
      message: 'The caster refused the user name or password',
    });
    jest.advanceTimersByTime(NTRIP_RETRY_MS * 2);
    expect(k.casters).toHaveLength(1);
  });

  it('v2: an unknown mountpoint is a 404', async () => {
    const k = fakeCasterSockets('v2');
    const { c, states } = client(k.factory);
    c.start({ ...GR30_PROFILE, mountpoint: 'NOPE' }, 's3cret', null);
    await Promise.resolve();
    expect(states.at(-1)?.message).toBe('The caster has no mountpoint “NOPE”');
  });

  it('a dropped stream reconnects with the latest position in the request', async () => {
    const k = fakeCasterSockets('v2');
    const { c, states } = client(k.factory);
    c.start(GR30_PROFILE, 's3cret', null);
    await Promise.resolve();
    expect(k.last().request?.headers['ntrip-gga']).toBeUndefined();
    c.tick(fixOf('autonomous'));
    k.drop('the caster stopped sending');
    expect(states.at(-1)).toMatchObject({ phase: 'error', message: 'the caster stopped sending' });
    jest.advanceTimersByTime(NTRIP_RETRY_MS);
    await Promise.resolve();
    expect(k.casters).toHaveLength(2);
    expect(k.last().request?.headers['ntrip-gga']).toMatch(/^\$GPGGA,/);
    expect(states.at(-1)?.phase).toBe('streaming');
    c.stop();
  });

  it.each(['gr30', 'v2'] as const)('%s: the mountpoint browser lists its stream', async (d) => {
    const k = fakeCasterSockets(d);
    for (const version of [1, 2] as const) {
      const table = await fetchSourcetable(k.factory, { ...GR30_PROFILE, version }, 's3cret');
      expect(table.streams.map((s) => [s.mountpoint, s.lat, s.lon])).toEqual([
        ['Quebec_RTCM3x', null, null],
      ]);
    }
  });
});
