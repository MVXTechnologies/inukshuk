/**
 * The map's bottom-right corner (#476, round 3), pinned at the source level
 * (MapScreen is too heavy to mount in Jest; `asyncEventRead.guard` does the
 * same):
 *
 * - the ⓘ credit button is gone and the corner holds the tip button;
 * - the basemap credit stays ON the map as text (OpenStreetMap's attribution
 *   guideline and Esri's terms expect it on the map view itself);
 * - the tip button lives on the Map only — not on Library, Explore or Logbook.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('map corner', () => {
  const map = read('src/features/map/MapScreen.tsx');

  it('has no ⓘ credit button any more', () => {
    expect(map).not.toMatch(/AttributionChip/);
    expect(existsSync(join(ROOT, 'src/features/map/components/AttributionChip.tsx'))).toBe(false);
  });

  it('keeps the credit visible on the map as text', () => {
    expect(map).toMatch(
      /<MapCreditText basemap=\{basemap\} vector=\{stoneBase\} osmLabels=\{imageryLabels\} \/>/,
    );
  });

  it('puts the tip button in the bottom-right corner', () => {
    expect(map).toMatch(/styles\.bottomSideEnd\][^]*?<TipButton/);
  });
});

describe('tip button is Map-only', () => {
  it.each([
    'src/features/library/LibraryScreen.tsx',
    'src/features/store/StoreScreen.tsx',
    'src/features/dashboard/DashboardScreen.tsx',
    'app/(tabs)/_layout.tsx',
  ])('%s has no tip button', (path) => {
    expect(read(path)).not.toMatch(/TipButton|TipJarButton|FloatingTipJar/);
  });
});

describe('tip button pause', () => {
  const map = read('src/features/map/MapScreen.tsx');

  it('pauses only for the person panning or zooming, not for follow-location moves', () => {
    expect(map).toMatch(
      /onRegionWillChange=\{\(e\) => \{\s*if \(e\.nativeEvent\.userInteraction\) setCameraMoving\(true\);/,
    );
    expect(map).toMatch(/onRegionDidChange=\{\(e\) => \{\s*setCameraMoving\(false\);/);
    expect(map).toMatch(/paused=\{cameraMoving\}/);
  });
});

describe('coffee mascot bubble', () => {
  const map = read('src/features/map/MapScreen.tsx');

  it('is drawn at the Map root so Android delivers its taps', () => {
    expect(map).toMatch(/<TipBubble right=\{TIP_BUBBLE_RIGHT\} bottom=\{TIP_BUBBLE_BOTTOM\} \/>/);
    expect(map).not.toMatch(/styles\.bottomSideEnd\][^<]*<TipBubble/);
  });

  it.each([
    'railMenuOpen',
    'trailSheetUp',
    'pickingCategory',
    'recordRequested',
    'modelSheetOpen',
    'selecting',
    'makeMapState !== null',
  ])('stays away while %s', (guard) => {
    const block = /bubbleBlocked=\{([^}]*)\}/.exec(map)?.[1] ?? '';
    expect(block).toContain(guard);
  });

  it('only runs while the Map tab is in front', () => {
    expect(map).toMatch(/focused=\{isFocused\}/);
  });
});
