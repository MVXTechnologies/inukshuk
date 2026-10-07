import { asciiToBytes, bytesToAscii, concatBytes } from './bytes';
import { parseNmea } from './nmea';
import {
  buildGga,
  buildNtripRequest,
  ChunkedDecoder,
  ggaDecision,
  NtripConfigError,
  NtripResponseParser,
  NTRIP_MAX_HEADER,
  type NtripEndpoint,
} from './ntrip';
import { encodeRtcm3 } from './rtcm3';
import { parseSourcetable } from './sourcetable';
import { loadText, prng, randomChunks } from './testUtils';

const EP: NtripEndpoint = {
  host: 'caster.example.org',
  port: 2101,
  mountpoint: 'QCAA',
  version: 1,
  username: 'me@example.org',
  password: 'none',
};

describe('request', () => {
  it('v1: HTTP/1.0-style GET with Basic auth', () => {
    expect(bytesToAscii(buildNtripRequest(EP))).toBe(
      'GET /QCAA HTTP/1.0\r\nUser-Agent: NTRIP Inukshuk/1.0\r\nAuthorization: Basic bWVAZXhhbXBsZS5vcmc6bm9uZQ==\r\nAccept: */*\r\nConnection: close\r\n\r\n',
    );
  });

  it('v2: HTTP/1.1 with Host, Ntrip-Version and an optional Ntrip-GGA', () => {
    const gga = '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47';
    const s = bytesToAscii(
      buildNtripRequest({ ...EP, version: 2 }, { gga: `${gga}\r\n`, userAgent: 'NTRIP Test/2' }),
    );
    expect(s).toBe(
      `GET /QCAA HTTP/1.1\r\nHost: caster.example.org:2101\r\nNtrip-Version: Ntrip/2.0\r\nUser-Agent: NTRIP Test/2\r\nAuthorization: Basic bWVAZXhhbXBsZS5vcmc6bm9uZQ==\r\nNtrip-GGA: ${gga}\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
    );
    // port 80 is implied; no credentials → no Authorization; '' asks for the sourcetable
    const t = bytesToAscii(
      buildNtripRequest({ host: 'h.example', port: 80, mountpoint: '', version: 2 }),
    );
    expect(t).toContain('GET / HTTP/1.1\r\nHost: h.example\r\n');
    expect(t).not.toContain('Authorization');
    // UTF-8 credentials
    expect(bytesToAscii(buildNtripRequest({ ...EP, username: 'é', password: '' }))).toContain(
      'Basic w6k6',
    );
    expect(
      bytesToAscii(
        buildNtripRequest({ ...EP, host: '[2001:db8::1]', username: undefined, password: 'x' }),
      ),
    ).toContain('Basic Ong=');
  });

  it('refuses header injection and invalid settings', () => {
    expect(() => buildNtripRequest({ ...EP, mountpoint: 'A B' })).toThrow(NtripConfigError);
    expect(() => buildNtripRequest({ ...EP, mountpoint: 'A\r\nX: y' })).toThrow(NtripConfigError);
    expect(() => buildNtripRequest({ ...EP, host: 'bad host' })).toThrow(NtripConfigError);
    expect(() => buildNtripRequest({ ...EP, port: 0 })).toThrow(NtripConfigError);
    expect(() => buildNtripRequest({ ...EP, port: 2101.5 })).toThrow(NtripConfigError);
    expect(() => buildNtripRequest({ ...EP, password: 'a\nb' })).toThrow(NtripConfigError);
    expect(() => buildNtripRequest({ ...EP, username: 'a:b' })).toThrow(NtripConfigError);
    expect(() => buildNtripRequest(EP, { userAgent: 'x\r\ny' })).toThrow(NtripConfigError);
    expect(() => buildNtripRequest({ ...EP, version: 2 }, { gga: 'GPGGA,no-dollar' })).toThrow(
      NtripConfigError,
    );
  });
});

describe('response', () => {
  const rtcm = encodeRtcm3(Uint8Array.from([0x3e, 0xd0, 0x00, 0x01]));

  it('v1 ICY 200 OK: data straight after the status line, with or without a blank line', () => {
    for (const sep of ['', '\r\n', '\n']) {
      const p = new NtripResponseParser();
      const r = p.push(concatBytes([asciiToBytes(`ICY 200 OK\r\n${sep}`), rtcm]));
      expect(p.head).toMatchObject({ status: 'streaming', protocol: 'ICY', code: 200 });
      expect([...r.data]).toEqual([...rtcm]);
      expect(r.done).toBe(false);
    }
    // the blank line split across reads
    const p = new NtripResponseParser();
    expect(p.push(asciiToBytes('ICY 200 OK\r\n\r')).data.length).toBe(0);
    expect([...p.push(concatBytes([asciiToBytes('\n'), rtcm])).data]).toEqual([...rtcm]);
    expect([...p.push(rtcm).data]).toEqual([...rtcm]);
  });

  it('waits for a complete status line / header block, byte by byte', () => {
    const msg = concatBytes([
      asciiToBytes('HTTP/1.1 200 OK\r\nContent-Type: gnss/data\r\n\r\n'),
      rtcm,
    ]);
    const p = new NtripResponseParser();
    const out: number[] = [];
    for (const c of randomChunks(msg, () => 0, 1)) out.push(...p.push(c).data);
    expect(p.head?.status).toBe('streaming');
    expect(out).toEqual([...rtcm]);
  });

  it('v2 chunked transfer: chunk framing is stripped across arbitrary reads', () => {
    const body = concatBytes([rtcm, rtcm]);
    const chunked = concatBytes([
      asciiToBytes(
        'HTTP/1.1 200 OK\r\nNtrip-Version: Ntrip/2.0\r\nTransfer-Encoding: chunked\r\nContent-Type: gnss/data\r\n\r\n',
      ),
      asciiToBytes(`${rtcm.length.toString(16)};ext=1\r\n`),
      rtcm,
      asciiToBytes(`\r\n${rtcm.length.toString(16).toUpperCase()}\r\n`),
      rtcm,
      asciiToBytes('\r\n0\r\nX-Trailer: 1\r\n\r\n'),
    ]);
    const rnd = prng(11);
    for (let k = 0; k < 30; k++) {
      const p = new NtripResponseParser();
      const out: number[] = [];
      let done = false;
      for (const c of randomChunks(chunked, rnd, 9)) {
        const r = p.push(c);
        out.push(...r.data);
        done = r.done;
      }
      expect(p.head).toMatchObject({
        status: 'streaming',
        chunked: true,
        headers: { 'ntrip-version': 'Ntrip/2.0' },
      });
      expect(out).toEqual([...body]);
      expect(done).toBe(true);
      expect(p.push(rtcm)).toEqual({ data: new Uint8Array(0), done: true });
    }
  });

  it('a malformed chunk size or missing CRLF ends the body', () => {
    const d = new ChunkedDecoder();
    d.push(asciiToBytes('zz\r\n'));
    expect(d.failed).toBe(true);
    expect(d.push(asciiToBytes('1\r\n'))).toEqual(new Uint8Array(0));
    const e = new ChunkedDecoder();
    e.push(asciiToBytes('1\r\nAB\r\n'));
    expect(e.failed).toBe(true);
    const f = new ChunkedDecoder();
    f.push(asciiToBytes('x'.repeat(1100)));
    expect(f.failed).toBe(true);
    expect(f.done).toBe(false);
  });

  it('status codes: 401, 404, other errors, SOURCETABLE, HTTP sourcetable', () => {
    const st = (s: string) => {
      const p = new NtripResponseParser();
      p.push(asciiToBytes(s));
      return p.head?.status;
    };
    expect(st('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic\r\n\r\n')).toBe('unauthorized');
    expect(st('HTTP/1.0 404 Not Found\r\n\r\n')).toBe('not-found');
    expect(st('HTTP/1.1 503 Busy\n\n')).toBe('error');
    expect(st('ICY 401 Unauthorized\r\n')).toBe('error');
    expect(st('SOURCETABLE 500 Oops\r\n\r\n')).toBe('error');
    expect(st('HTTP/1.1 200 OK\r\nContent-Type: gnss/sourcetable\r\n\r\n')).toBe('sourcetable');
    expect(st('HTTP/1.1 200 OK\r\n\r\n')).toBe('streaming');
    expect(st('HTTP/1.1 200 OK\r\nContent-Type: gnss/data\r\n')).toBeUndefined(); // headers not finished
    expect(st('<html>')).toBeUndefined(); // no line yet, printable
    expect(st('\x00\xff')).toBe('bad-response');
    expect(st('<html>hello</html>\r\n')).toBe('bad-response');
  });

  it('a header block that never ends is a bad response', () => {
    const p = new NtripResponseParser();
    p.push(asciiToBytes('HTTP/1.1 200 OK\r\n'));
    const r = p.push(asciiToBytes(`X: ${'a'.repeat(NTRIP_MAX_HEADER)}`));
    expect(p.head?.status).toBe('bad-response');
    expect(r.done).toBe(true);
    const q = new NtripResponseParser();
    expect(q.push(asciiToBytes('x'.repeat(NTRIP_MAX_HEADER + 1))).done).toBe(true);
  });

  it('the v1 sourcetable (real SAPOS answer, gpsd capture) ends at ENDSOURCETABLE', () => {
    const raw = loadText('gpsd/ntrip_sourcetable.log')
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .join('\n');
    const p = new NtripResponseParser();
    let text = '';
    let done = false;
    for (const c of randomChunks(asciiToBytes(raw), prng(5), 40)) {
      const r = p.push(c);
      text += bytesToAscii(r.data);
      done = done || r.done;
    }
    expect(p.head).toMatchObject({
      status: 'sourcetable',
      protocol: 'SOURCETABLE',
      headers: { server: 'NTRIP AdVCaster V1.071b/1.0' },
    });
    expect(done).toBe(true);
    const t = parseSourcetable(text);
    expect(t.complete).toBe(true);
    expect(t.streams.map((s) => s.mountpoint)).toEqual(['VRS_3_2G', 'MAC_3_2G', 'FKP_3_2G', 'EPS']);
    // an ENDSOURCETABLE split across two reads is still seen
    const q = new NtripResponseParser();
    q.push(asciiToBytes('SOURCETABLE 200 OK\r\n\r\nSTR;x;\r\nENDSOURCE'));
    expect(q.push(asciiToBytes('TABLE\r\n')).done).toBe(true);
  });
});

describe('GGA upload', () => {
  const base = {
    nmeaRequired: true,
    consent: true,
    lastSentMs: null,
    nowMs: 100_000,
    havePosition: true,
  };

  it('sends only what the caster needs, with consent, at the interval', () => {
    expect(ggaDecision(base)).toEqual({ send: true });
    expect(ggaDecision({ ...base, nmeaRequired: false })).toEqual({
      send: false,
      reason: 'not-required',
    });
    expect(ggaDecision({ ...base, consent: false })).toEqual({ send: false, reason: 'no-consent' });
    expect(ggaDecision({ ...base, havePosition: false })).toEqual({
      send: false,
      reason: 'no-position',
    });
    expect(ggaDecision({ ...base, lastSentMs: 95_000 })).toEqual({
      send: false,
      reason: 'not-due',
    });
    expect(ggaDecision({ ...base, lastSentMs: 90_000 })).toEqual({ send: true });
    // the interval never goes below 5 s
    expect(ggaDecision({ ...base, lastSentMs: 97_000, intervalS: 1 })).toEqual({
      send: false,
      reason: 'not-due',
    });
    expect(ggaDecision({ ...base, lastSentMs: 95_000, intervalS: 1 })).toEqual({ send: true });
  });

  it('builds a valid GGA that our own parser reads back', () => {
    const s = buildGga({
      timeMs: Date.UTC(2026, 9, 1, 13, 5, 7, 250),
      lat: 46.803,
      lon: -71.217,
      hEll: 60.1234,
      quality: 4,
      satsUsed: 7,
      hdop: 0.84,
      ageS: 1.2,
    });
    expect(
      s.startsWith(
        '$GPGGA,130507.25,4648.18000000,N,07113.02000000,W,4,07,0.8,60.123,M,0.000,M,1.2,*',
      ),
    ).toBe(true);
    const r = parseNmea(s);
    if (!r.ok || r.msg.type !== 'GGA') throw new Error();
    expect(r.msg.lat).toBeCloseTo(46.803, 10);
    expect(r.msg.lon).toBeCloseTo(-71.217, 10);
    const e = buildGga({
      timeMs: Date.UTC(2026, 9, 1),
      lat: -0.5,
      lon: 179.99999999999,
      hEll: null,
      quality: 1,
      satsUsed: null,
      hdop: null,
      ageS: null,
    });
    expect(e).toContain(',S,');
    // minutes that round to 60 carry into the degrees
    expect(e).toContain('18000.00000000,E');
    expect(parseNmea(e).ok).toBe(true);
  });
});
