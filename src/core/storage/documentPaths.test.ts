import { isAbsolutePath, joinDocumentPath, toDocumentRelativePath } from './documentPaths';

// The container UUID an iOS build was installed under, and the one it rotates
// to on the next update. These two strings are the whole of #247.
const OLD_DOC_DIR =
  'file:///var/mobile/Containers/Data/Application/AAAAAAAA-1111-2222-3333-444444444444/Documents';
const NEW_DOC_DIR =
  'file:///var/mobile/Containers/Data/Application/BBBBBBBB-5555-6666-7777-888888888888/Documents';
const ANDROID_DOC_DIR = 'file:///data/user/0/com.mvx.inukshuk/files';

describe('isAbsolutePath', () => {
  it.each([
    'file:///var/mobile/Documents/tracks/a.gpx',
    'content://com.android.providers.downloads/1',
    'https://example.com/a.gpx',
    '/var/mobile/Documents/tracks/a.gpx',
  ])('treats %s as absolute', (value) => {
    expect(isAbsolutePath(value)).toBe(true);
  });

  it.each(['tracks/a.gpx', 'maps/b.pdf', 'photos/c.jpg', ''])('treats %s as relative', (value) => {
    expect(isAbsolutePath(value)).toBe(false);
  });
});

describe('toDocumentRelativePath', () => {
  it('strips the current document directory', () => {
    expect(toDocumentRelativePath(`${NEW_DOC_DIR}/tracks/a.gpx`, NEW_DOC_DIR)).toBe('tracks/a.gpx');
  });

  it('tolerates a document directory given with a trailing slash', () => {
    expect(toDocumentRelativePath(`${NEW_DOC_DIR}/maps/b.pdf`, `${NEW_DOC_DIR}/`)).toBe(
      'maps/b.pdf',
    );
  });

  it('strips a ROTATED container prefix the current directory no longer matches', () => {
    // The bug: persisted under the old UUID, read back under the new one.
    expect(toDocumentRelativePath(`${OLD_DOC_DIR}/tracks/a.gpx`, NEW_DOC_DIR)).toBe('tracks/a.gpx');
  });

  it('strips a rotated container prefix with no document directory to compare against', () => {
    expect(toDocumentRelativePath(`${OLD_DOC_DIR}/photos/c.jpg`)).toBe('photos/c.jpg');
  });

  it('heals the Android document directory too, via the prefix rule', () => {
    // Android's container is stable, so it never rotates — but an index moved
    // between an old and a new install path still relativises.
    expect(toDocumentRelativePath(`${ANDROID_DOC_DIR}/tracks/a.gpx`, ANDROID_DOC_DIR)).toBe(
      'tracks/a.gpx',
    );
  });

  it('is idempotent — a relative path is returned untouched', () => {
    const once = toDocumentRelativePath(`${OLD_DOC_DIR}/tracks/a.gpx`, NEW_DOC_DIR);
    expect(toDocumentRelativePath(once, NEW_DOC_DIR)).toBe(once);
    expect(toDocumentRelativePath('maps/b.pdf', NEW_DOC_DIR)).toBe('maps/b.pdf');
  });

  it('leaves an absolute path outside any document directory alone', () => {
    // Not ours to rewrite: a cache file, or a path from a foreign app.
    const cache = 'file:///var/mobile/Containers/Data/Application/X/Library/Caches/overlays/a.png';
    expect(toDocumentRelativePath(cache, NEW_DOC_DIR)).toBe(cache);
    expect(toDocumentRelativePath('content://downloads/7', NEW_DOC_DIR)).toBe(
      'content://downloads/7',
    );
  });

  it('keeps a subdirectory whose own name contains "Documents"', () => {
    // The FIRST marker wins, so nothing below the container root is eaten.
    expect(toDocumentRelativePath(`${OLD_DOC_DIR}/photos/Documents/c.jpg`)).toBe(
      'photos/Documents/c.jpg',
    );
  });

  it('leaves the bare document directory itself alone (no empty relative path)', () => {
    expect(toDocumentRelativePath(`${NEW_DOC_DIR}/`, NEW_DOC_DIR)).toBe(`${NEW_DOC_DIR}/`);
  });

  it('passes the empty string through', () => {
    expect(toDocumentRelativePath('', NEW_DOC_DIR)).toBe('');
  });
});

describe('joinDocumentPath', () => {
  it('rebuilds an absolute uri against the current document directory', () => {
    expect(joinDocumentPath(NEW_DOC_DIR, 'tracks/a.gpx')).toBe(`${NEW_DOC_DIR}/tracks/a.gpx`);
    expect(joinDocumentPath(`${NEW_DOC_DIR}/`, 'tracks/a.gpx')).toBe(`${NEW_DOC_DIR}/tracks/a.gpx`);
  });

  it('passes an already-absolute path through untouched', () => {
    expect(joinDocumentPath(NEW_DOC_DIR, 'content://downloads/7')).toBe('content://downloads/7');
    expect(joinDocumentPath(NEW_DOC_DIR, `${OLD_DOC_DIR}/tracks/a.gpx`)).toBe(
      `${OLD_DOC_DIR}/tracks/a.gpx`,
    );
  });

  it('round-trips against the CURRENT container after a rotation', () => {
    const stale = `${OLD_DOC_DIR}/tracks/a.gpx`;
    const healed = joinDocumentPath(NEW_DOC_DIR, toDocumentRelativePath(stale, NEW_DOC_DIR));
    expect(healed).toBe(`${NEW_DOC_DIR}/tracks/a.gpx`);
  });

  it('passes the empty string through', () => {
    expect(joinDocumentPath(NEW_DOC_DIR, '')).toBe('');
  });
});
