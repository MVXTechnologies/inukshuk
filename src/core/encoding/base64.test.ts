import { bytesToBase64 } from './base64';

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
