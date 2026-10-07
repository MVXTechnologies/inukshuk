import { hasLocation, jpegWithGps, realJpeg } from './__fixtures__/jpegs';
import { stripJpegMetadata } from './jpegStrip';
import { shareableJpeg } from './shareable';

describe('shareableJpeg', () => {
  it('passes a clean canvas JPEG through untouched', () => {
    expect(shareableJpeg(realJpeg())).toEqual({ kind: 'clean' });
  });

  it('strips a photo that still carries GPS and a Motion Photo trailer', () => {
    const dirty = jpegWithGps();
    expect(hasLocation(dirty)).toBe(true);
    const out = shareableJpeg(dirty);
    expect(out.kind).toBe('stripped');
    if (out.kind !== 'stripped') return;
    expect(hasLocation(out.bytes)).toBe(false);
    expect(out.removed).toBeGreaterThan(0);
  });

  it('treats an already-stripped "Full size" copy (orientation kept) as clean', () => {
    const fullSize = stripJpegMetadata(jpegWithGps(6)).bytes;
    expect(shareableJpeg(fullSize)).toEqual({ kind: 'clean' });
  });

  it('refuses what it cannot parse', () => {
    expect(shareableJpeg(new Uint8Array([1, 2, 3]))).toEqual({ kind: 'unreadable' });
  });
});
