/**
 * Room protocol parsing (src/protocol.ts) and a seeded fuzz of the room's
 * message handler: hostile frames never throw, never get past the caps.
 */
import { fromB64u, toB64u as coreToB64u } from '../../../../src/core/team/bytes';
import { mulberry32 } from '../../../../src/core/team/testing/prop';
import {
  fromB64uLen,
  isBlobText,
  isHandle,
  isRoomId,
  parseClientFrame,
  positiveInt,
  toB64u,
} from '../src/protocol';
import { take } from '../src/limits';
import { blobText, makeRoom, msg, vectorRoom } from './harness';

describe('base64url agrees with the phone’s codec', () => {
  it('round-trips every length 0..40 and matches src/core/team/bytes', () => {
    const rand = mulberry32(1);
    for (let n = 0; n <= 40; n++) {
      const bytes = Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
      const text = toB64u(bytes);
      expect(text).toBe(coreToB64u(bytes));
      expect(fromB64uLen(text, n)).toEqual(bytes);
      expect(fromB64u(text)).toEqual(bytes);
    }
  });

  it('is strict: wrong length, foreign characters, non-zero trailing bits', () => {
    const id = toB64u(new Uint8Array(16).fill(9));
    expect(isRoomId(id)).toBe(true);
    expect(isRoomId(id + 'A')).toBe(false);
    expect(isRoomId(id.slice(0, 21) + '=')).toBe(false);
    expect(isRoomId(id.slice(0, 21) + 'B')).toBe(false); // trailing bits set
    expect(isRoomId(null)).toBe(false);
    expect(isHandle('AAECAwQFBgc')).toBe(true);
    expect(isHandle('AAECAwQFBgd')).toBe(false);
  });

  it('blob text: only bucket lengths of base64url', () => {
    expect(isBlobText(blobText(256))).toBe(true);
    expect(isBlobText(blobText(255))).toBe(false);
    expect(isBlobText('!'.repeat(342))).toBe(false);
    expect(isBlobText(5)).toBe(false);
  });
});

describe('parseClientFrame', () => {
  it('accepts the three client frames', () => {
    expect(parseClientFrame('{"t":"turn"}')).toEqual({ t: 'turn' });
    expect(parseClientFrame(msg('*'))).toEqual({ t: 'm', to: '*', b: blobText() });
    expect(parseClientFrame('{"t":"auth","pub":"a","sig":"b"}')).toEqual({
      t: 'auth',
      pub: 'a',
      sig: 'b',
    });
  });

  it.each([
    ['{"t":"turn","x":1}'],
    ['{"t":"auth","pub":1,"sig":"b"}'],
    ['{"t":"auth","pub":"a"}'],
    ['{"t":"m","to":"nope","b":"x"}'],
    [JSON.stringify({ t: 'm', to: '*', b: blobText(), extra: 1 })],
    ['{"t":"__proto__"}'],
    ['{"__proto__":{"t":"turn"}}'],
    ['"turn"'],
    ['[{"t":"turn"}]'],
    ['nul'],
    ['x'.repeat(30_000)],
  ])('refuses %s', (raw) => {
    expect(parseClientFrame(raw)).toBeUndefined();
  });

  it('never throws on random input', () => {
    const rand = mulberry32(42);
    for (let i = 0; i < 2000; i++) {
      const len = Math.floor(rand() * 64);
      const s = String.fromCharCode(...Array.from({ length: len }, () => Math.floor(rand() * 128)));
      expect(() => parseClientFrame(s)).not.toThrow();
    }
    expect(parseClientFrame(undefined)).toBeUndefined();
  });
});

describe('limits arithmetic', () => {
  it('a bucket refills at its rate up to its burst, never charges on refusal', () => {
    let b = { tokens: 2, at: 0 };
    b = take(b, 0, 2, 1, 2)!;
    expect(b.tokens).toBe(0);
    expect(take(b, 500, 1, 1, 2)).toBeUndefined();
    expect(take(b, 1000, 1, 1, 2)).toEqual({ tokens: 0, at: 1000 });
    expect(take(b, 1_000_000, 1, 1, 2)).toEqual({ tokens: 1, at: 1_000_000 });
    // A clock going backwards refills nothing.
    expect(take({ tokens: 0, at: 5000 }, 4000, 1, 1, 2)).toBeUndefined();
  });

  it('positiveInt', () => {
    expect(positiveInt('5', 1)).toBe(5);
    expect(positiveInt('0', 1)).toBe(1);
    expect(positiveInt('-3', 1)).toBe(1);
    expect(positiveInt('2.5', 1)).toBe(1);
    expect(positiveInt(undefined, 7)).toBe(7);
  });
});

describe('fuzz: the room message handler (seeded)', () => {
  it('random JSON, binary, oversize and wrong types never throw; the socket ends closed or intact', async () => {
    const rand = mulberry32(705);
    const R = vectorRoom();
    const shapes: (() => string | ArrayBuffer)[] = [
      () =>
        JSON.stringify({
          t: ['m', 'auth', 'turn', 'x'][Math.floor(rand() * 4)],
          to: '*',
          b: blobText(256),
        }),
      () =>
        JSON.stringify({
          t: 'm',
          to: '*',
          b: blobText([256, 1024, 4096, 16384, 100][Math.floor(rand() * 5)]!),
        }),
      () => '{"t":"auth","pub":"' + 'A'.repeat(Math.floor(rand() * 50)) + '","sig":""}',
      () => new ArrayBuffer(Math.floor(rand() * 100)),
      () => 'x'.repeat(Math.floor(rand() * 30_000)),
      () => String(rand()),
      () => '{"t":"turn"}',
    ];
    for (let round = 0; round < 60; round++) {
      const h = makeRoom();
      const a = round % 2 === 0 ? await h.join(R, 'a') : await h.connect(R.roomId, 'a');
      await h.join(R, 'b');
      for (let i = 0; i < 20 && !a.closed; i++) {
        h.clock.now += Math.floor(rand() * 200);
        const shape = shapes[Math.floor(rand() * shapes.length)]!;
        await expect(h.room.webSocketMessage(a, shape())).resolves.toBeUndefined();
      }
      expect(h.touched).toEqual([]);
      // Whatever happened, the other socket only ever got well-formed server frames.
      for (const s of h.sockets) {
        for (const f of s.sent) expect(['chal', 'ok', 'join', 'leave', 'm', 'turn']).toContain(f.t);
      }
    }
  });
});
