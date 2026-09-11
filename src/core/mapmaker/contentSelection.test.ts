import type { BoundingBox } from '@core/models';
import {
  bboxesIntersect,
  pointOnPage,
  pointsOnPage,
  resolvePointsToLoad,
  resolveTracksToLoad,
  trackTouchesPage,
  tracksOnPage,
} from './contentSelection';

const PAGE: BoundingBox = { minLng: -71.3, maxLng: -71.2, minLat: 46.78, maxLat: 46.84 };
const box = (minLng: number, minLat: number, maxLng: number, maxLat: number): BoundingBox => ({
  minLng,
  minLat,
  maxLng,
  maxLat,
});

describe('bboxesIntersect', () => {
  it('sees overlap, containment and identity', () => {
    expect(bboxesIntersect(PAGE, box(-71.25, 46.8, -71.22, 46.82))).toBe(true);
    expect(bboxesIntersect(PAGE, box(-72, 46, -70, 47))).toBe(true);
    expect(bboxesIntersect(PAGE, PAGE)).toBe(true);
  });

  it('rejects boxes that miss on either axis', () => {
    expect(bboxesIntersect(PAGE, box(-71.1, 46.8, -71.05, 46.82))).toBe(false); // east
    expect(bboxesIntersect(PAGE, box(-71.5, 46.8, -71.4, 46.82))).toBe(false); // west
    expect(bboxesIntersect(PAGE, box(-71.25, 46.9, -71.22, 46.95))).toBe(false); // north
    expect(bboxesIntersect(PAGE, box(-71.25, 46.6, -71.22, 46.7))).toBe(false); // south
  });

  it('counts a shared edge as overlapping — a trail along the neatline prints', () => {
    expect(bboxesIntersect(PAGE, box(-71.2, 46.84, -71.1, 46.9))).toBe(true);
  });

  it('is symmetric', () => {
    const other = box(-71.25, 46.8, -71.0, 46.9);
    expect(bboxesIntersect(PAGE, other)).toBe(bboxesIntersect(other, PAGE));
  });
});

describe('trackTouchesPage', () => {
  it('keeps a track whose bbox reaches the page', () => {
    expect(trackTouchesPage({ id: 'a', bbox: box(-71.25, 46.8, -71.22, 46.82) }, PAGE)).toBe(true);
  });

  it('drops one that cannot reach it', () => {
    expect(trackTouchesPage({ id: 'b', bbox: box(-70, 45, -69.9, 45.1) }, PAGE)).toBe(false);
  });

  // Being wrong here costs one wasted parse; being wrong the other way would
  // silently drop a trail the user asked for.
  it('keeps a track with no recorded bbox rather than guessing', () => {
    expect(trackTouchesPage({ id: 'c' }, PAGE)).toBe(true);
  });
});

describe('pointOnPage', () => {
  it('includes the interior and the boundary, excludes the outside', () => {
    expect(pointOnPage({ id: '1', longitude: -71.25, latitude: 46.81 }, PAGE)).toBe(true);
    expect(pointOnPage({ id: '2', longitude: -71.3, latitude: 46.78 }, PAGE)).toBe(true);
    expect(pointOnPage({ id: '3', longitude: -71.19, latitude: 46.81 }, PAGE)).toBe(false);
    expect(pointOnPage({ id: '4', longitude: -71.25, latitude: 46.9 }, PAGE)).toBe(false);
  });
});

describe('tracksOnPage / pointsOnPage', () => {
  const tracks = [
    { id: 'near', bbox: box(-71.25, 46.8, -71.22, 46.82) },
    { id: 'far', bbox: box(-60, 20, -59, 21) },
    { id: 'unknown' },
  ];

  it('seeds the picker with everything that could print', () => {
    expect(tracksOnPage(tracks, PAGE)).toEqual(['near', 'unknown']);
  });

  it('returns the waypoints inside the frame', () => {
    const pts = [
      { id: 'in', longitude: -71.25, latitude: 46.81 },
      { id: 'out', longitude: 0, latitude: 0 },
    ];
    expect(pointsOnPage(pts, PAGE)).toEqual(['in']);
  });
});

describe('resolveTracksToLoad', () => {
  const tracks = [
    { id: 'near', bbox: box(-71.25, 46.8, -71.22, 46.82) },
    { id: 'alsoNear', bbox: box(-71.28, 46.79, -71.26, 46.8) },
    { id: 'far', bbox: box(-60, 20, -59, 21) },
  ];

  // The whole point of #356: this is what decides how many GPX files get read.
  it('loads only the chosen tracks', () => {
    expect(resolveTracksToLoad(tracks, PAGE, ['near'])).toEqual(['near']);
  });

  it('still excludes a chosen track that cannot reach the page', () => {
    // The user picked it on an earlier frame, then panned away before Create.
    expect(resolveTracksToLoad(tracks, PAGE, ['near', 'far'])).toEqual(['near']);
  });

  it('loads nothing for an empty selection', () => {
    expect(resolveTracksToLoad(tracks, PAGE, [])).toEqual([]);
  });

  it('treats an absent selection as "everything that could print"', () => {
    expect(resolveTracksToLoad(tracks, PAGE, undefined)).toEqual(['near', 'alsoNear']);
  });

  it('ignores ids that are no longer in the library', () => {
    expect(resolveTracksToLoad(tracks, PAGE, ['near', 'deleted'])).toEqual(['near']);
  });
});

describe('resolvePointsToLoad', () => {
  const pts = [
    { id: 'in', longitude: -71.25, latitude: 46.81 },
    { id: 'in2', longitude: -71.22, latitude: 46.79 },
    { id: 'out', longitude: 0, latitude: 0 },
  ];

  it('intersects the choice with the page', () => {
    expect(resolvePointsToLoad(pts, PAGE, ['in', 'out'])).toEqual(['in']);
    expect(resolvePointsToLoad(pts, PAGE, undefined)).toEqual(['in', 'in2']);
    expect(resolvePointsToLoad(pts, PAGE, [])).toEqual([]);
  });
});
