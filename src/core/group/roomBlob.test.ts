import { concatBytes, fromB64u, fromHex, toB64u, utf8 } from '../team/bytes';
import { createNobleCrypto } from '../team/nobleCrypto';
import { nobleCrypto } from '../team/testing/noble';
import { nodeCrypto } from '../team/testing/nodeCrypto';
import { mulberry32 } from '../team/testing/prop';

import { deriveRoom, RDV_DOMAIN, u32be } from './rdv';
import vectors from './rdv.vectors.json';
import {
  bucketFor,
  FRESH_FUTURE_S,
  FRESH_PAST_S,
  isHandle,
  openRoomBlob,
  openRoomBlobText,
  peekRoomBlob,
  ReplayWindow,
  ROOM_BLOB_BUCKETS,
  ROOM_BLOB_MAX_BYTES,
  ROOM_BLOB_MAX_PAYLOAD,
  ROOM_BLOB_TEXT_LENGTHS,
  type RoomBlobContext,
  sealRoomBlob,
  sealRoomBlobText,
} from './roomBlob';

const hex = (h: string) => fromHex(h)!;
const V = vectors.blob;
const NOW = V.nowSeconds;
const FROM = V.fromHandle;
const OTHER = 'BwYFBAMCAQA';
const ctx: RoomBlobContext = { roomId: V.roomId, day: V.day, roomKey: hex(V.roomKey) };
const c = nobleCrypto;

describe('pinned blob vector (shared with the Worker tests)', () => {
  it('opens to the pinned payload with noble and with Node', () => {
    for (const impl of [nobleCrypto, nodeCrypto]) {
      const out = openRoomBlobText(impl, ctx, FROM, V.blobB64u, NOW);
      expect(out).toEqual(utf8(V.payloadUtf8));
    }
  });

  it('re-seals byte-identically with the pinned nonce', () => {
    const fixed = createNobleCrypto((b) => {
      for (let i = 0; i < b.length; i++) b[i] = (0x40 + i) & 255;
    });
    expect(sealRoomBlobText(fixed, ctx, FROM, utf8(V.payloadUtf8), NOW)).toBe(V.blobB64u);
  });

  it('the room key of the vector is the day-0 room of the pinned rs', () => {
    const room = deriveRoom(c, hex(vectors.rs), V.day);
    expect(room.roomId).toBe(V.roomId);
    expect(Buffer.from(room.roomKey).toString('hex')).toBe(V.roomKey);
  });
});

describe('R-RDV-3 + R-META-3: sealed and padded to buckets', () => {
  it.each([0, 1, 100, 209, 210, 1000, 4000, 16000, ROOM_BLOB_MAX_PAYLOAD])(
    'round-trips a %d-byte payload at exactly a bucket size',
    (n) => {
      const payload = Uint8Array.from({ length: n }, (_, i) => (i * 7) & 255);
      const blob = sealRoomBlob(c, ctx, FROM, payload, NOW);
      expect(ROOM_BLOB_BUCKETS).toContain(blob.length);
      expect(blob.length).toBe(bucketFor(n));
      expect(openRoomBlob(c, ctx, FROM, blob, NOW)).toEqual(payload);
    },
  );

  it('picks the smallest bucket that fits, none past the maximum', () => {
    expect(bucketFor(0)).toBe(256);
    expect(bucketFor(256 - 47)).toBe(256);
    expect(bucketFor(256 - 46)).toBe(1024);
    expect(bucketFor(ROOM_BLOB_MAX_PAYLOAD)).toBe(ROOM_BLOB_MAX_BYTES);
    expect(bucketFor(ROOM_BLOB_MAX_PAYLOAD + 1)).toBeUndefined();
  });

  it('refuses to seal an oversized payload or with a bad context', () => {
    expect(() =>
      sealRoomBlob(c, ctx, FROM, new Uint8Array(ROOM_BLOB_MAX_PAYLOAD + 1), NOW),
    ).toThrow(RangeError);
    expect(() => sealRoomBlob(c, ctx, 'nope', new Uint8Array(1), NOW)).toThrow(TypeError);
    expect(() =>
      sealRoomBlob(c, { ...ctx, roomKey: new Uint8Array(16) }, FROM, new Uint8Array(1), NOW),
    ).toThrow(TypeError);
    expect(() => sealRoomBlob(c, { ...ctx, day: -1 }, FROM, new Uint8Array(1), NOW)).toThrow(
      TypeError,
    );
  });

  it('text lengths match the buckets (what the server checks)', () => {
    expect(ROOM_BLOB_TEXT_LENGTHS).toEqual([342, 1366, 5462, 21846]);
    expect(V.blobB64u).toHaveLength(342);
  });

  it('carries no plaintext (payload, room id, handle) in the blob bytes', () => {
    const secret = 'group-id-oKGio6SlpqeoqaqrrK2urw 46.8139,-71.2080 note text';
    const text = sealRoomBlobText(c, ctx, FROM, utf8(secret), NOW);
    const raw = Buffer.from(fromB64u(text)!).toString('latin1');
    for (const needle of ['oKGio6', '46.8139', 'note text', V.roomId, FROM]) {
      expect(raw).not.toContain(needle);
      expect(text).not.toContain(needle);
    }
  });
});

describe('authentication: wrong key, day, room or sender is dropped', () => {
  const blob = sealRoomBlob(c, ctx, FROM, utf8('hi'), NOW);

  it('wrong room key', () => {
    expect(openRoomBlob(c, { ...ctx, roomKey: new Uint8Array(32) }, FROM, blob, NOW)).toBe(
      undefined,
    );
  });

  it('wrong day (yesterday’s room)', () => {
    expect(openRoomBlob(c, { ...ctx, day: ctx.day - 1 }, FROM, blob, NOW)).toBeUndefined();
  });

  it('wrong room id (two rooms spliced)', () => {
    const other = deriveRoom(c, hex(vectors.ir), V.day);
    expect(openRoomBlob(c, { ...ctx, roomId: other.roomId }, FROM, blob, NOW)).toBeUndefined();
  });

  it('re-attributed to another handle by the server', () => {
    expect(openRoomBlob(c, ctx, OTHER, blob, NOW)).toBeUndefined();
  });

  it('tampered header, nonce or ciphertext', () => {
    for (const i of [0, 3, 10, 40, blob.length - 1]) {
      const t = blob.slice();
      t[i] = t[i]! ^ 1;
      expect(openRoomBlob(c, ctx, FROM, t, NOW)).toBeUndefined();
    }
  });

  it('bad context or handle on open', () => {
    expect(openRoomBlob(c, { ...ctx, roomId: 'x' }, FROM, blob, NOW)).toBeUndefined();
    expect(openRoomBlob(c, ctx, 12, blob, NOW)).toBeUndefined();
  });
});

describe('§2.7: 5-minute freshness', () => {
  const at = (ts: number) => sealRoomBlob(c, ctx, FROM, utf8('x'), ts);

  it('accepts up to 5 minutes old, drops older', () => {
    expect(openRoomBlob(c, ctx, FROM, at(NOW - FRESH_PAST_S), NOW)).toBeDefined();
    expect(openRoomBlob(c, ctx, FROM, at(NOW - FRESH_PAST_S - 1), NOW)).toBeUndefined();
  });

  it('accepts a little clock lead, drops a blob dated far ahead', () => {
    expect(openRoomBlob(c, ctx, FROM, at(NOW + FRESH_FUTURE_S), NOW)).toBeDefined();
    expect(openRoomBlob(c, ctx, FROM, at(NOW + FRESH_FUTURE_S + 1), NOW)).toBeUndefined();
  });

  it('peek reads the clear header without the key', () => {
    expect(peekRoomBlob(at(NOW))?.ts).toBe(NOW);
    expect(peekRoomBlob(new Uint8Array(255))).toBeUndefined();
    expect(peekRoomBlob('nope')).toBeUndefined();
  });
});

describe('padding and length are strict (one plaintext, one blob)', () => {
  /** Seal an arbitrary inner plaintext with a valid header, to reach the inner checks. */
  function forge(plain: Uint8Array): Uint8Array {
    const head = concatBytes(new Uint8Array([1]), u32be(NOW));
    const nonce = new Uint8Array(24).fill(5);
    const aad = concatBytes(
      utf8(RDV_DOMAIN + 'blob\n'),
      utf8(ctx.roomId),
      u32be(ctx.day),
      head,
      utf8(FROM),
    );
    return concatBytes(head, nonce, c.aead.seal(ctx.roomKey, nonce, plain, aad));
  }
  const inner = 256 - 45;

  it('accepts a well-formed forged plaintext (control)', () => {
    const plain = new Uint8Array(inner);
    plain[1] = 2;
    plain[2] = 65;
    plain[3] = 66;
    expect(openRoomBlob(c, ctx, FROM, forge(plain), NOW)).toEqual(utf8('AB'));
  });

  it('refuses non-zero padding', () => {
    const plain = new Uint8Array(inner);
    plain[1] = 1;
    plain[inner - 1] = 1;
    expect(openRoomBlob(c, ctx, FROM, forge(plain), NOW)).toBeUndefined();
  });

  it('refuses a length past the plaintext', () => {
    const plain = new Uint8Array(inner);
    plain[0] = 0xff;
    plain[1] = 0xff;
    expect(openRoomBlob(c, ctx, FROM, forge(plain), NOW)).toBeUndefined();
  });

  it('refuses another version byte or a non-bucket size', () => {
    const blob = sealRoomBlob(c, ctx, FROM, utf8('x'), NOW);
    const v2 = blob.slice();
    v2[0] = 2;
    expect(openRoomBlob(c, ctx, FROM, v2, NOW)).toBeUndefined();
    expect(openRoomBlob(c, ctx, FROM, blob.subarray(0, 255), NOW)).toBeUndefined();
    expect(openRoomBlob(c, ctx, FROM, concatBytes(blob, new Uint8Array(1)), NOW)).toBeUndefined();
  });
});

describe('text form', () => {
  it('refuses wrong lengths, foreign characters and non-strings', () => {
    const text = sealRoomBlobText(c, ctx, FROM, utf8('x'), NOW);
    expect(openRoomBlobText(c, ctx, FROM, text, NOW)).toEqual(utf8('x'));
    expect(openRoomBlobText(c, ctx, FROM, text.slice(1), NOW)).toBeUndefined();
    expect(openRoomBlobText(c, ctx, FROM, '!' + text.slice(1), NOW)).toBeUndefined();
    expect(openRoomBlobText(c, ctx, FROM, 7, NOW)).toBeUndefined();
    expect(openRoomBlobText(c, ctx, FROM, 'A'.repeat(100_000), NOW)).toBeUndefined();
  });

  it('handles are 11 base64url characters', () => {
    expect(isHandle(FROM)).toBe(true);
    expect(isHandle('AAECAwQFBg')).toBe(false);
    expect(isHandle(null)).toBe(false);
  });
});

describe('ReplayWindow', () => {
  it('drops a replayed blob inside the window', () => {
    const w = new ReplayWindow();
    const blob = sealRoomBlob(c, ctx, FROM, utf8('x'), NOW);
    expect(w.accept(blob, NOW)).toBe(true);
    expect(w.accept(blob, NOW + 10)).toBe(false);
    expect(w.accept(blob.slice(), NOW + 100)).toBe(false);
  });

  it('drops stale or malformed blobs and forgets expired nonces', () => {
    const w = new ReplayWindow();
    const old = sealRoomBlob(c, ctx, FROM, utf8('x'), NOW);
    expect(w.accept(old, NOW)).toBe(true);
    expect(w.accept(old, NOW + FRESH_PAST_S + 1)).toBe(false); // stale anyway
    expect(w.accept(sealRoomBlob(c, ctx, FROM, utf8('y'), NOW + 400), NOW + 400)).toBe(true);
    expect(w.size).toBe(1); // the first nonce expired
    expect(w.accept(new Uint8Array(3), NOW)).toBe(false);
  });

  it('stays bounded under a flood', () => {
    const w = new ReplayWindow(64);
    for (let i = 0; i < 500; i++) {
      expect(w.accept(sealRoomBlob(c, ctx, FROM, utf8(String(i)), NOW), NOW)).toBe(true);
    }
    expect(w.size).toBe(64);
  });
});

describe('fuzz: opening hostile bytes never throws', () => {
  it('random blobs, bucket-sized blobs and bit flips', () => {
    const rand = mulberry32(705);
    const valid = sealRoomBlob(c, ctx, FROM, utf8('payload'), NOW);
    for (let i = 0; i < 2000; i++) {
      let input: unknown;
      switch (i % 4) {
        case 0:
          input = Uint8Array.from({ length: Math.floor(rand() * 600) }, () =>
            Math.floor(rand() * 256),
          );
          break;
        case 1: {
          const b = Uint8Array.from({ length: 256 }, () => Math.floor(rand() * 256));
          b[0] = 1;
          b.set(u32be(NOW), 1);
          input = b;
          break;
        }
        case 2: {
          const b = valid.slice();
          const at = Math.floor(rand() * b.length);
          b[at] = b[at]! ^ (1 << Math.floor(rand() * 8));
          input = b;
          break;
        }
        default:
          input = [undefined, null, {}, 'x', 42, [1, 2]][i % 6];
      }
      expect(() => openRoomBlob(c, ctx, FROM, input, NOW)).not.toThrow();
      expect(openRoomBlob(c, ctx, FROM, input, NOW)).toBeUndefined();
      expect(() => openRoomBlobText(c, ctx, FROM, toB64u(new Uint8Array(256)), NOW)).not.toThrow();
    }
  });
});
