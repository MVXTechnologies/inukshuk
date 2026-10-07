import { base64ToBytes, bytesToBase64 } from './base64';

const enc = (s: string) => bytesToBase64(new Uint8Array([...s].map((c) => c.charCodeAt(0))));

describe('bytesToBase64', () => {
  it('matches RFC 4648 test vectors', () => {
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('Zg==');
    expect(enc('fo')).toBe('Zm8=');
    expect(enc('foo')).toBe('Zm9v');
    expect(enc('foob')).toBe('Zm9vYg==');
    expect(enc('fooba')).toBe('Zm9vYmE=');
    expect(enc('foobar')).toBe('Zm9vYmFy');
  });

  it('handles full-range binary bytes', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    // Round-trip through Node's Buffer as the reference implementation.
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('stays correct on megabyte-scale inputs', () => {
    const bytes = new Uint8Array(1_000_003); // non-multiple of 3 → padding path
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});

describe('base64ToBytes', () => {
  const dec = (s: string) => {
    const b = base64ToBytes(s);
    return b === null ? null : String.fromCharCode(...b);
  };

  it('matches RFC 4648 test vectors, padded or not', () => {
    expect(dec('')).toBe('');
    expect(dec('Zg==')).toBe('f');
    expect(dec('Zm8=')).toBe('fo');
    expect(dec('Zm9v')).toBe('foo');
    expect(dec('Zm9vYg==')).toBe('foob');
    expect(dec('Zm9vYmE=')).toBe('fooba');
    expect(dec('Zm9vYmFy')).toBe('foobar');
    expect(dec('Zg')).toBe('f');
    expect(dec('Zm8')).toBe('fo');
  });

  it('round-trips full-range and large binary data', () => {
    const bytes = new Uint8Array(70_001);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131 + 7) & 0xff;
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(base64ToBytes(Buffer.from(bytes).toString('base64'))).toEqual(bytes);
  });

  it('rejects corrupt input instead of guessing', () => {
    expect(base64ToBytes('Z')).toBeNull(); // impossible length
    expect(base64ToBytes('Zm9v!A==')).toBeNull(); // foreign character
    expect(base64ToBytes('Zm=v')).toBeNull(); // padding inside
    expect(base64ToBytes('Zh==')).toBeNull(); // non-zero padding bits
    expect(base64ToBytes('Zm9véA==')).toBeNull(); // non-ASCII
    expect(base64ToBytes('Zm9vYg-_')).toBeNull(); // URL-safe alphabet is not ours
  });
});
