import { toB64u } from '../team/bytes';
import { mulberry32 } from '../team/testing/prop';
import { ROOM_BLOB_TEXT_LENGTHS } from './roomBlob';
import {
  authFrame,
  decodeRoomPayload,
  encodeRoomPayload,
  initiatesTo,
  messageFrame,
  parseServerFrame,
  ROOM_KIND,
  TURN_REQUEST,
} from './roomProto';

const H1 = toB64u(new Uint8Array(8).fill(1));
const H2 = toB64u(new Uint8Array(8).fill(2));
const CHAL = toB64u(new Uint8Array(32).fill(7));
const BLOB = 'A'.repeat(ROOM_BLOB_TEXT_LENGTHS[0]!);
const j = (o: unknown) => JSON.stringify(o);

describe('room protocol (phone side)', () => {
  it('parses every server frame the Worker sends', () => {
    expect(parseServerFrame(j({ t: 'chal', c: CHAL, now: 1_790_000_000 }))).toEqual({
      t: 'chal',
      c: new Uint8Array(32).fill(7),
      now: 1_790_000_000,
    });
    expect(parseServerFrame(j({ t: 'ok', me: H1, peers: [H2], now: 5 }))).toEqual({
      t: 'ok',
      me: H1,
      peers: [H2],
      now: 5,
    });
    expect(parseServerFrame(j({ t: 'join', h: H2 }))).toEqual({ t: 'join', h: H2 });
    expect(parseServerFrame(j({ t: 'leave', h: H2 }))).toEqual({ t: 'leave', h: H2 });
    expect(parseServerFrame(j({ t: 'm', from: H2, b: BLOB }))).toEqual({
      t: 'm',
      from: H2,
      b: BLOB,
    });
    const ice = [
      { urls: ['stun:stun.cloudflare.com:3478'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u1', credential: 'c+/=' },
    ];
    expect(parseServerFrame(j({ t: 'turn', ice, ttl: 900 }))).toEqual({ t: 'turn', ice, ttl: 900 });
    expect(parseServerFrame(j({ t: 'turn', e: 'budget' }))).toEqual({ t: 'turn', e: 'budget' });
    expect(parseServerFrame(j({ t: 'turn', e: 'what' }))).toEqual({ t: 'turn', e: 'error' });
  });

  it('refuses malformed, oversized or unknown frames (total, strict)', () => {
    for (const bad of [
      undefined,
      42,
      'not json',
      '[]',
      'null',
      j({ t: 'chal', c: CHAL }),
      j({ t: 'chal', c: 'short', now: 1 }),
      j({ t: 'chal', c: CHAL, now: -1 }),
      j({ t: 'ok', me: 'x', peers: [], now: 1 }),
      j({ t: 'ok', me: H1, peers: ['x'], now: 1 }),
      j({ t: 'ok', me: H1, peers: new Array(129).fill(H2), now: 1 }),
      j({ t: 'join', h: H2, x: 1 }),
      j({ t: 'm', from: H2, b: 'short' }),
      j({ t: 'm', from: H2, b: BLOB, to: H1 }),
      j({ t: 'turn', ice: [], ttl: 900 }),
      j({ t: 'turn', ice: [{ urls: ['http://evil'] }], ttl: 900 }),
      j({ t: 'turn', ice: [{ urls: ['turn:x'], username: 'u' }], ttl: 900 }),
      j({ t: 'turn', ice: [{ urls: ['turn:x'], extra: 1 }], ttl: 900 }),
      j({ t: 'turn', ice: [{ urls: ['turn:x'] }], ttl: 0 }),
      j({ t: 'nope' }),
      'x'.repeat(30_000),
    ]) {
      expect(parseServerFrame(bad)).toBeUndefined();
    }
  });

  it('fuzz: random text never throws', () => {
    const rnd = mulberry32(5);
    for (let i = 0; i < 2000; i++) {
      const len = Math.floor(rnd() * 80);
      let s = '';
      for (let k = 0; k < len; k++) s += String.fromCharCode(32 + Math.floor(rnd() * 95));
      expect(() => parseServerFrame(s)).not.toThrow();
      expect(() => parseServerFrame(`{"t":"ok","me":${s}}`)).not.toThrow();
    }
  });

  it('encodes client frames exactly as the Worker parses them', () => {
    expect(JSON.parse(authFrame(new Uint8Array(32), new Uint8Array(64)))).toEqual({
      t: 'auth',
      pub: toB64u(new Uint8Array(32)),
      sig: toB64u(new Uint8Array(64)),
    });
    expect(JSON.parse(messageFrame(H2, BLOB))).toEqual({ t: 'm', to: H2, b: BLOB });
    expect(JSON.parse(TURN_REQUEST)).toEqual({ t: 'turn' });
  });

  it('frames session bytes in room payloads, and one side of a pair initiates', () => {
    const p = encodeRoomPayload(ROOM_KIND.frame, Uint8Array.of(9, 8));
    expect(decodeRoomPayload(p)).toEqual({ kind: ROOM_KIND.frame, frame: Uint8Array.of(9, 8) });
    expect(decodeRoomPayload(Uint8Array.of(ROOM_KIND.hello))).toBeUndefined();
    expect(decodeRoomPayload(Uint8Array.of(7, 1))).toBeUndefined();
    expect(decodeRoomPayload(new Uint8Array(0))).toBeUndefined();
    expect(initiatesTo(H1, H2)).toBe(true);
    expect(initiatesTo(H2, H1)).toBe(false);
  });
});
