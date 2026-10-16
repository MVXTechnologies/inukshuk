/**
 * The NTRIP protocol layer against fake casters that reproduce real wire
 * bytes (#751): a Leica GR30 acting as caster (v1 replies to v2 requests,
 * `Content-Length:89` without a space, `ICY 200 OK`), and a strict NTRIP 2.0
 * caster (HTTP/1.1, chunked). Every reply is fed in seeded random splits.
 */
import { asciiToBytes, bytesToAscii } from './bytes';
import { buildGga, buildNtripRequest, NMEA_MAX_LENGTH, NtripResponseParser } from './ntrip';
import { parseNmea } from './nmea';
import { encodeRtcm3 } from './rtcm3';
import { caseVariant, isRtcm3, parseSourcetable, rankMountpoints } from './sourcetable';
import {
  FakeCaster,
  GR30_STR,
  prng,
  randomChunks,
  type CasterDialect,
  type FakeCasterOptions,
} from './testUtils';

const HOST = 'caster.example.invalid';
const OPTS: Omit<FakeCasterOptions, 'dialect'> = {
  mountpoint: 'Quebec_RTCM3x',
  user: 'rover@example.org',
  pass: 's3cret',
};

/** One request → reply exchange; the reply fed to the parser in random pieces. */
function exchange(
  dialect: CasterDialect,
  ask: { mountpoint: string; version: 1 | 2; user?: string; pass?: string },
  seed = 1,
) {
  const caster = new FakeCaster({ ...OPTS, dialect });
  const req = buildNtripRequest({
    host: HOST,
    port: 2103,
    mountpoint: ask.mountpoint,
    version: ask.version,
    username: ask.user ?? OPTS.user,
    password: ask.pass ?? OPTS.pass,
  });
  const reply = caster.receive(req);
  const parser = new NtripResponseParser();
  const out: number[] = [];
  let done = false;
  for (const c of randomChunks(reply, prng(seed), 7)) {
    const r = parser.push(c);
    out.push(...r.data);
    done = done || r.done;
  }
  return { caster, parser, reply, body: Uint8Array.from(out), done };
}

const rtcm = encodeRtcm3(Uint8Array.from([0x43, 0x50, 0x00, 0x01, 0x02, 0x03]));

describe('Leica GR30 (v1 replies whatever the request version)', () => {
  it('the sourcetable reply is byte-exact: SOURCETABLE 200 OK, Content-Length:89', () => {
    const { reply } = exchange('gr30', { mountpoint: '', version: 2 });
    expect(bytesToAscii(reply)).toBe(
      'SOURCETABLE 200 OK\r\nServer: GR30 4.83.342/1.0\r\nContent-Type: text/plain\r\nContent-Length:89\r\n\r\n' +
        `${GR30_STR}\r\nENDSOURCETABLE\r\n`,
    );
  });

  it.each([1, 2] as const)(
    'NTRIP %i request: the sourcetable parses, with its header lacking a space',
    (version) => {
      for (let seed = 1; seed <= 20; seed++) {
        const { parser, body, done } = exchange('gr30', { mountpoint: '', version }, seed);
        expect(parser.head).toMatchObject({
          status: 'sourcetable',
          protocol: 'SOURCETABLE',
          code: 200,
          headers: { 'content-length': '89', server: 'GR30 4.83.342/1.0' },
        });
        expect(done).toBe(true);
        const t = parseSourcetable(bytesToAscii(body));
        expect(t).toMatchObject({ complete: true, badLines: 0 });
        expect(t.streams).toHaveLength(1);
        expect(t.streams[0]).toMatchObject({
          mountpoint: 'Quebec_RTCM3x',
          identifier: 'MRNF',
          format: 'RTCM 3.x MSM4',
          navSystem: 'GPS_GLO_GAL_BDS',
          lat: null,
          lon: null,
          nmea: false,
          carrier: null,
          authentication: 'basic',
          misc: 'none',
        });
      }
    },
  );

  it('a stream without a position is kept (last, distance null — never NaN) by nearest-first', () => {
    const { body } = exchange('gr30', { mountpoint: '', version: 2 });
    const gr30 = parseSourcetable(bytesToAscii(body)).streams;
    const near = parseSourcetable(
      'STR;NEAR;Near;RTCM 3.2;;2;GPS;X;CAN;46.80;-71.20;0;0;x;none;B;N;0;\r\nENDSOURCETABLE\r\n',
    ).streams;
    const ranked = rankMountpoints([...gr30, ...near], 46.8, -71.2);
    expect(ranked.map((r) => r.stream.mountpoint)).toEqual(['NEAR', 'Quebec_RTCM3x']);
    expect(ranked[1]).toMatchObject({ distanceKm: null, usable: true });
    expect(ranked.every((r) => r.distanceKm === null || Number.isFinite(r.distanceKm))).toBe(true);
    expect(isRtcm3(gr30[0]!)).toBe(true);
  });

  it.each(['gr30', 'gr30-icy-headers'] as const)(
    '%s: ICY 200 OK to an Ntrip/2.0 request, then RTCM untouched',
    (dialect) => {
      for (let seed = 1; seed <= 20; seed++) {
        const caster = new FakeCaster({ ...OPTS, dialect });
        const req = buildNtripRequest({
          host: HOST,
          port: 2103,
          mountpoint: 'Quebec_RTCM3x',
          version: 2,
          username: OPTS.user,
          password: OPTS.pass,
        });
        expect(bytesToAscii(req)).toMatch(/^GET \/Quebec_RTCM3x HTTP\/1\.1\r\n/);
        const wire = [...caster.receive(req), ...caster.data(rtcm), ...caster.data(rtcm)];
        expect(caster.streaming).toBe(true);
        const parser = new NtripResponseParser();
        const out: number[] = [];
        for (const c of randomChunks(Uint8Array.from(wire), prng(seed), 5))
          out.push(...parser.push(c).data);
        expect(parser.head).toMatchObject({ status: 'streaming', protocol: 'ICY', code: 200 });
        expect(out).toEqual([...rtcm, ...rtcm]);
        if (dialect === 'gr30-icy-headers')
          expect(parser.head?.headers.server).toBe('GR30 4.83.342/1.0');
      }
    },
  );

  it('the mountpoint is case-sensitive: an uppercased one gets the sourcetable back', () => {
    const { parser, body, done } = exchange('gr30', { mountpoint: 'QUEBEC_RTCM3X', version: 2 });
    expect(parser.head?.status).toBe('sourcetable');
    expect(done).toBe(true);
    const streams = parseSourcetable(bytesToAscii(body)).streams;
    expect(caseVariant(streams, 'QUEBEC_RTCM3X')).toBe('Quebec_RTCM3x');
    expect(caseVariant(streams, 'Quebec_RTCM3x')).toBeNull();
    expect(caseVariant(streams, 'OTHER')).toBeNull();
  });

  it('wrong password: 401 with a header lacking a space', () => {
    const { parser } = exchange('gr30', { mountpoint: 'Quebec_RTCM3x', version: 2, pass: 'x' });
    expect(parser.head).toMatchObject({
      status: 'unauthorized',
      code: 401,
      headers: { 'www-authenticate': 'Basic realm="/Quebec_RTCM3x"', 'content-length': '0' },
    });
  });
});

describe('strict NTRIP 2.0 caster (HTTP/1.1, chunked)', () => {
  it('chunked sourcetable', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { parser, body, done } = exchange('v2', { mountpoint: '', version: 2 }, seed);
      expect(parser.head).toMatchObject({ status: 'sourcetable', chunked: true });
      expect(done).toBe(true);
      expect(parseSourcetable(bytesToAscii(body)).streams[0]?.mountpoint).toBe('Quebec_RTCM3x');
    }
  });

  it('chunked RTCM: chunk framing removed across any split', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const caster = new FakeCaster({ ...OPTS, dialect: 'v2' });
      const head = caster.receive(
        buildNtripRequest({
          host: HOST,
          port: 2101,
          mountpoint: 'Quebec_RTCM3x',
          version: 2,
          username: OPTS.user,
          password: OPTS.pass,
        }),
      );
      const wire = Uint8Array.from([...head, ...caster.data(rtcm), ...caster.data(rtcm)]);
      const parser = new NtripResponseParser();
      const out: number[] = [];
      for (const c of randomChunks(wire, prng(seed), 6)) out.push(...parser.push(c).data);
      expect(parser.head).toMatchObject({
        status: 'streaming',
        protocol: 'HTTP/1.1',
        chunked: true,
      });
      expect(out).toEqual([...rtcm, ...rtcm]);
    }
  });

  it('401 and 404', () => {
    expect(
      exchange('v2', { mountpoint: 'Quebec_RTCM3x', version: 2, pass: 'no' }).parser.head?.status,
    ).toBe('unauthorized');
    expect(exchange('v2', { mountpoint: 'NOPE', version: 2 }).parser.head?.status).toBe(
      'not-found',
    );
  });
});

describe('other v1 caster quirks', () => {
  const head = (s: string) => {
    const p = new NtripResponseParser();
    const r = p.push(asciiToBytes(s));
    return { head: p.head, data: bytesToAscii(r.data), done: r.done };
  };

  it('a sourcetable straight after its status line (no header block)', () => {
    const r = head(`SOURCETABLE 200 OK\r\n${GR30_STR}\r\nENDSOURCETABLE\r\n`);
    expect(r.head?.status).toBe('sourcetable');
    expect(r.done).toBe(true);
    expect(parseSourcetable(r.data).streams[0]?.mountpoint).toBe('Quebec_RTCM3x');
    // …split in the middle of the first STR line
    const p = new NtripResponseParser();
    expect(p.push(asciiToBytes('SOURCETABLE 200 OK\r\nSTR')).data.length).toBe(0);
    expect(p.head).toBeNull();
    const rest = p.push(asciiToBytes(';X;\r\nENDSOURCETABLE\r\n'));
    expect(bytesToAscii(rest.data)).toBe('STR;X;\r\nENDSOURCETABLE\r\n');
    // …or once the partial line can no longer be a header
    const q = new NtripResponseParser();
    expect(bytesToAscii(q.push(asciiToBytes('SOURCETABLE 200 OK\r\nSTR;X')).data)).toBe('STR;X');
    expect(q.head?.status).toBe('sourcetable');
  });

  it('a header block split right before its blank line waits for it', () => {
    const p = new NtripResponseParser();
    p.push(asciiToBytes('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r'));
    expect(p.head).toBeNull();
    const r = p.push(asciiToBytes('\n4\r\nabcd\r\n'));
    expect(p.head?.chunked).toBe(true);
    expect(bytesToAscii(r.data)).toBe('abcd');
    // a header line split before its LF
    const q = new NtripResponseParser();
    q.push(asciiToBytes('HTTP/1.1 200 OK\r\nContent-Type: gnss/data\r'));
    expect(q.head).toBeNull();
  });

  it('plain-word refusals, stray line breaks and lower case', () => {
    expect(head('ERROR - Bad Password\r\n').head).toMatchObject({
      status: 'unauthorized',
      protocol: 'ERROR',
    });
    expect(head('ERROR - Mount Point Taken or Invalid\r\n').head?.status).toBe('error');
    expect(head('\r\nICY 200 OK\r\n').head?.status).toBe('streaming');
    expect(head('icy 200 ok\r\n').head?.protocol).toBe('ICY');
    expect(head('HTTP/1.1 401\r\n\r\n').head?.status).toBe('unauthorized');
  });

  it('after ICY 200 OK, text that is not a header is data (RTCM 2 is printable)', () => {
    const p = new NtripResponseParser();
    p.push(asciiToBytes('ICY 200 OK\r\n'));
    const rtcm2 = 'fGh@IjK'.repeat(100); // 0x40–0x7F bytes, no line break
    let out = bytesToAscii(p.push(asciiToBytes(rtcm2)).data);
    expect(out).toBe(rtcm2);
    // a non-header line is data too
    const q = new NtripResponseParser();
    q.push(asciiToBytes('ICY 200 OK\r\n'));
    out = bytesToAscii(q.push(asciiToBytes('not a header\r\nmore')).data);
    expect(out).toBe('not a header\r\nmore');
    // …and so is a partial line that cannot become a header
    const r = new NtripResponseParser();
    r.push(asciiToBytes('ICY 200 OK\r\n'));
    expect(bytesToAscii(r.push(asciiToBytes('not a hea')).data)).toBe('not a hea');
  });
});

describe('GGA upload sentence', () => {
  it('fits NMEA’s 82 characters at the extremes, and parses back', () => {
    const s = buildGga({
      timeMs: Date.UTC(2026, 9, 1, 23, 59, 59, 999),
      lat: -89.99999999,
      lon: -179.99999999,
      hEll: -12345.678,
      quality: 4,
      satsUsed: 140,
      hdop: 250,
      ageS: 1234,
    });
    expect(s.length).toBeLessThanOrEqual(NMEA_MAX_LENGTH);
    expect(s).toMatch(/^\$GPGGA,235959\.99,/);
    expect(parseNmea(s).ok).toBe(true);
  });
});
