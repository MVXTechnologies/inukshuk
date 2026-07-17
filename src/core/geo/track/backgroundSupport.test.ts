import { backgroundTaskSupported } from './backgroundSupport';

describe('backgroundTaskSupported', () => {
  it('rejects the known-broken binaries (< 1.0.3)', () => {
    expect(backgroundTaskSupported('1.0.2')).toBe(false);
    expect(backgroundTaskSupported('1.0.1')).toBe(false);
    expect(backgroundTaskSupported('1.0.0')).toBe(false);
    expect(backgroundTaskSupported('0.9.9')).toBe(false);
  });

  it('accepts 1.0.3 and later', () => {
    expect(backgroundTaskSupported('1.0.3')).toBe(true);
    expect(backgroundTaskSupported('1.0.4')).toBe(true);
    expect(backgroundTaskSupported('1.1.0')).toBe(true);
    expect(backgroundTaskSupported('2.0.0')).toBe(true);
    expect(backgroundTaskSupported('1.0.10')).toBe(true);
  });

  it('compares numerically, not lexicographically', () => {
    expect(backgroundTaskSupported('1.0.30')).toBe(true);
    expect(backgroundTaskSupported('1.10.0')).toBe(true);
  });

  it('tolerates suffixes after the patch number', () => {
    expect(backgroundTaskSupported('1.0.2-beta.1')).toBe(false);
    expect(backgroundTaskSupported('1.0.3-rc.1')).toBe(true);
  });

  it('fails open on unknown/unparseable versions', () => {
    expect(backgroundTaskSupported(null)).toBe(true);
    expect(backgroundTaskSupported(undefined)).toBe(true);
    expect(backgroundTaskSupported('')).toBe(true);
    expect(backgroundTaskSupported('exposdk:56.0.0')).toBe(true);
  });
});
