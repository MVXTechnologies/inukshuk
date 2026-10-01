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

describe('tip mug vs map interaction', () => {
  const map = read('src/features/map/MapScreen.tsx');
  const button = read('src/features/support/TipButton.tsx');

  it('never pauses the mug for map interaction (owner): no pause prop at all', () => {
    expect(map).not.toMatch(/<TipButton[^>]*\bpaused=/);
    expect(button).not.toMatch(/\bpaused\??:/);
    // The gesture state reaches the button only as the bubble's guard.
    expect(map).toMatch(/gestureActive=\{cameraMoving\}/);
  });

  it('runs the loop on the UI thread, not on a JS timer', () => {
    expect(button).toMatch(
      /withRepeat\(withDelay\(gap, withSequence\(first, \.\.\.others\)\), -1, false\)/,
    );
    // The only JS interval left is the bubble's 1 s check.
    expect(button.match(/setInterval\(/g) ?? []).toHaveLength(1);
    expect(button).toMatch(
      /setInterval\(\(\) => \{\s*const store = useTipMascotStore\.getState\(\)/,
    );
  });

  it('tracks the person’s own pans and zooms (for the bubble) robustly', () => {
    expect(map).toMatch(/useState\(\(\) => createGesturePause\(setCameraMoving\)\)/);
    expect(map).toMatch(
      /onRegionWillChange=\{\(e\) => \{\s*gesturePause\.willChange\(e\.nativeEvent\.userInteraction === true\);/,
    );
    expect(map).toMatch(/onRegionDidChange=\{\(e\) => \{\s*gesturePause\.didChange\(\);/);
    // Nothing else may set it: only the controller (with its 3 s cap).
    expect(map.match(/setCameraMoving\(/g) ?? []).toHaveLength(0);
  });

  it('never counts a tap as a gesture (the iOS will-without-did trap)', () => {
    expect(map).toMatch(
      /const onMapPress = useCallback\(\s*\(e: MapPressEvent\) => \{\s*gesturePause\.tap\(\);/,
    );
    expect(map).toMatch(/onLongPress=\{\([^)]*\) => \{\s*gesturePause\.tap\(\);/);
  });
});

describe('coffee mascot bubble', () => {
  const map = read('src/features/map/MapScreen.tsx');

  it('is drawn at the Map root so Android delivers its taps', () => {
    expect(map).toMatch(/<TipBubble\s+right=\{TIP_BUBBLE_RIGHT\}/);
    expect(map).not.toMatch(/styles\.bottomSideEnd\][^<]*<TipBubble/);
  });

  it('sits above the measured bottom row, so it never covers the credit caption', () => {
    // The column and the row report their layout; the bubble's bottom is the
    // row's top (from the column's bottom edge) plus a gap.
    expect(map).toMatch(/onLayout=\{\(e\) => setBottomColumnH\(e\.nativeEvent\.layout\.height\)\}/);
    expect(map).toMatch(
      /style=\{styles\.bottomRow\}[^>]*onLayout=\{\(e\) => setBottomRowY\(e\.nativeEvent\.layout\.y\)\}/,
    );
    expect(map).toMatch(/bottom=\{bottomColumnH - bottomRowY \+ TIP_BUBBLE_GAP\}/);
    // The row holds the scale bar, the credit caption and the tip button.
    expect(map).toMatch(/styles\.bottomRow\}[^]*?<MapCreditText[^]*?<TipButton/);
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
