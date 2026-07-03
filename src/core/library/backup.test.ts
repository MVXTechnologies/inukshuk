import type { TrackStats, TrackSummary } from '@core/models';
import { backupZipName, planBackup, sanitizeEntryName } from './backup';

const stats: TrackStats = {
  distanceM: 1000,
  ascentM: 10,
  descentM: 5,
  durationS: 600,
  movingTimeS: 500,
  avgSpeedMps: 1.6,
  maxSpeedMps: 3,
  pointCount: 100,
};

function track(partial: Partial<TrackSummary> & { id: string; fileUri: string }): TrackSummary {
  return { name: partial.id, startedAt: 0, stats, ...partial };
}

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

describe('backupZipName', () => {
  it('formats a dated archive name with zero-padding', () => {
    expect(backupZipName(new Date(2026, 6, 3))).toBe('inukshuk-backup-2026-07-03.zip');
    expect(backupZipName(new Date(2026, 11, 25))).toBe('inukshuk-backup-2026-12-25.zip');
  });
});

describe('planBackup', () => {
  it('plans one deflated GPX entry per trail under tracks/', () => {
    const plan = planBackup([
      track({ id: 'a', fileUri: 'file:///doc/tracks/a.gpx' }),
      track({ id: 'b', fileUri: 'file:///doc/tracks/b.gpx' }),
    ]);
    expect(plan.entries).toEqual([
      {
        zipPath: 'tracks/a.gpx',
        sourceUri: 'file:///doc/tracks/a.gpx',
        kind: 'gpx',
        deflate: true,
      },
      {
        zipPath: 'tracks/b.gpx',
        sourceUri: 'file:///doc/tracks/b.gpx',
        kind: 'gpx',
        deflate: true,
      },
    ]);
    expect(plan.trackCount).toBe(2);
    expect(plan.photoCount).toBe(0);
  });

  it('plans stored (not deflated) photo entries for note photos under photos/', () => {
    const plan = planBackup([
      track({
        id: 'a',
        fileUri: 'file:///doc/tracks/a.gpx',
        notes: [
          {
            id: 'n1',
            distanceM: 0,
            text: 'x',
            createdAt: 0,
            photoUri: 'file:///doc/photos/p1.jpg',
          },
          { id: 'n2', distanceM: 5, text: 'y', createdAt: 0 }, // no photo
        ],
      }),
    ]);
    expect(plan.entries).toContainEqual({
      zipPath: 'photos/p1.jpg',
      sourceUri: 'file:///doc/photos/p1.jpg',
      kind: 'photo',
      deflate: false,
    });
    expect(plan.trackCount).toBe(1);
    expect(plan.photoCount).toBe(1);
  });

  it('dedupes colliding entry names with numeric suffixes', () => {
    const plan = planBackup([
      track({ id: 'a', fileUri: 'file:///doc/one/trail.gpx' }),
      track({ id: 'b', fileUri: 'file:///doc/two/trail.gpx' }),
      track({ id: 'c', fileUri: 'file:///doc/three/trail.gpx' }),
    ]);
    expect(plan.entries.map((e) => e.zipPath)).toEqual([
      'tracks/trail.gpx',
      'tracks/trail-2.gpx',
      'tracks/trail-3.gpx',
    ]);
  });

  it('packs a source uri referenced by several notes only once', () => {
    const photoUri = 'file:///doc/photos/shared.jpg';
    const plan = planBackup([
      track({
        id: 'a',
        fileUri: 'file:///doc/tracks/a.gpx',
        notes: [
          { id: 'n1', distanceM: 0, text: 'x', createdAt: 0, photoUri },
          { id: 'n2', distanceM: 9, text: 'y', createdAt: 0, photoUri },
        ],
      }),
    ]);
    expect(plan.entries.filter((e) => e.kind === 'photo')).toHaveLength(1);
    expect(plan.photoCount).toBe(1);
  });

  it('never collides with the reserved library.json slot and handles empty input', () => {
    expect(planBackup([])).toEqual({ entries: [], trackCount: 0, photoCount: 0 });
    // A pathological uri whose basename is library.json still lands under tracks/.
    const plan = planBackup([track({ id: 'a', fileUri: 'file:///doc/library.json' })]);
    expect(plan.entries[0]?.zipPath).toBe('tracks/library.json');
  });
});
