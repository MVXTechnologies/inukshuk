import { sanitizeEntryName, uniquePath } from './zipPaths';

describe('sanitizeEntryName', () => {
  it('keeps the basename of a file uri', () => {
    expect(sanitizeEntryName('file:///data/user/0/app/tracks/abc123.gpx')).toBe('abc123.gpx');
  });

  it('strips query strings and fragments', () => {
    expect(sanitizeEntryName('file:///photos/pic.jpg?x=1#frag')).toBe('pic.jpg');
  });

  it('decodes percent-escapes and replaces unsafe characters', () => {
    expect(sanitizeEntryName('file:///photos/my%20trail%20pic.jpg')).toBe('my_trail_pic.jpg');
    expect(sanitizeEntryName('we ird:na*me.png')).toBe('we_ird_na_me.png');
  });

  it('neutralizes path traversal and never returns an empty name', () => {
    expect(sanitizeEntryName('../../etc/passwd')).toBe('passwd');
    // A pure dot-segment reduces to nothing → fallback name.
    expect(sanitizeEntryName('..')).toBe('file');
    expect(sanitizeEntryName('')).toBe('file');
  });

  it('survives malformed percent-escapes', () => {
    expect(sanitizeEntryName('bad%zzname.gpx')).toBe('bad_zzname.gpx');
  });
});

describe('uniquePath', () => {
  it('claims a free path as-is', () => {
    const taken = new Set<string>();
    expect(uniquePath(taken, 'a/trail.gpx')).toBe('a/trail.gpx');
    expect(taken.has('a/trail.gpx')).toBe(true);
  });

  it('suffixes collisions before the extension', () => {
    const taken = new Set<string>();
    expect(uniquePath(taken, 'trail.gpx')).toBe('trail.gpx');
    expect(uniquePath(taken, 'trail.gpx')).toBe('trail-2.gpx');
    expect(uniquePath(taken, 'trail.gpx')).toBe('trail-3.gpx');
  });

  it('suffixes extension-less paths at the end', () => {
    const taken = new Set<string>(['Alps']);
    expect(uniquePath(taken, 'Alps')).toBe('Alps-2');
  });

  it('treats a leading-dot name as extension-less', () => {
    const taken = new Set<string>(['.hidden']);
    expect(uniquePath(taken, '.hidden')).toBe('.hidden-2');
  });
});
