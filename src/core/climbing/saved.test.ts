import fixtures from './__fixtures__/crags.json';
import { parseCragDetail } from './detail';
import {
  cragMapBounds,
  cragPoints,
  emptyClimbingDoc,
  migrateClimbingDoc,
  savedBytes,
  savedCragsGeoJSON,
  savedFromDetail,
  updateAvailable,
} from './saved';

const weir = parseCragDetail(fixtures.Weir)!;
const saved = savedFromDetail(weir, { savedAt: 1, topoBytes: 4000, packId: 'p', packBytes: 6e6 });

describe('saved crags', () => {
  it('keep what the map draws offline', () => {
    expect(saved).toMatchObject({ uid: weir.uid, version: weir.v, routes: 230, packId: 'p' });
    expect(saved.sectors).toHaveLength(weir.sectors.length);
    const ordered = weir.sectors.filter((s) => s.ordered).reduce((n, s) => n + s.routes.length, 0);
    expect(saved.starts.filter((s) => s[2] > 0)).toHaveLength(ordered);
    expect(savedBytes(saved)).toBe(4000 + 6e6);
  });

  it('draw a badge, sector pins and route starts', () => {
    const fc = savedCragsGeoJSON([saved]);
    const kinds = fc.features.map((f) => f.properties.kind);
    expect(kinds.filter((k) => k === 'crag')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'sector')).toHaveLength(
      weir.sectors.filter((s) => s.pt).length,
    );
    expect(kinds.filter((k) => k === 'start').length).toBeGreaterThan(100);
    const bw = fc.features.find((f) => f.properties.n === 'Black and White · 28 routes');
    expect(bw).toBeDefined();
    // A one-sector crag gets no pin on its own badge.
    const lone = {
      ...saved,
      sectors: [{ name: 'Weir', pt: [0, 0] as [number, number], routes: 3 }],
      starts: [],
    };
    expect(savedCragsGeoJSON([lone]).features).toHaveLength(1);
  });

  it('frame a 2 km map around the crag and its sectors', () => {
    const b = cragMapBounds(cragPoints(weir));
    expect(b.minLat).toBeCloseTo(
      Math.min(weir.lat, ...weir.sectors.flatMap((s) => (s.pt ? [s.pt[1]] : []))) - 2000 / 111_320,
    );
    // ~2 km each side of a single point, east-west as north-south.
    const one = cragMapBounds([[0, 0]]);
    expect((one.maxLng - one.minLng) * 111.32).toBeCloseTo(4, 1);
    expect((one.maxLat - one.minLat) * 111.32).toBeCloseTo(4, 1);
  });

  it('notice newer topos', () => {
    expect(updateAvailable(saved, weir.v)).toBe(false);
    expect(updateAvailable(saved, 'ffffffff')).toBe(true);
    expect(updateAvailable(saved, undefined)).toBe(false);
  });

  it('migrate whatever was persisted', () => {
    expect(migrateClimbingDoc(null)).toEqual(emptyClimbingDoc());
    const doc = migrateClimbingDoc({
      schemaVersion: 1,
      saved: [
        saved,
        saved,
        { uid: 'bad' },
        { ...saved, uid: 'two', attachments: [{ id: 1 }], starts: [[1, 2]] },
      ],
    });
    expect(doc.saved.map((s) => s.uid)).toEqual([weir.uid, 'two']);
    expect(doc.saved[1]?.attachments).toEqual([]);
    expect(doc.saved[1]?.starts).toEqual([]);
    const kept = savedFromDetail(
      weir,
      { savedAt: 2, topoBytes: 1, packId: null, packBytes: 0 },
      {
        ...saved,
        attachments: [
          {
            id: 'a',
            kind: 'pdf',
            name: 't.pdf',
            path: 'climbing/attachments/a.pdf',
            bytes: 9,
            addedAt: 1,
          },
        ],
      },
    );
    expect(kept.attachments).toHaveLength(1);
  });
});
