/**
 * The map's bottom-right corner (#476, round 3), pinned at the source level
 * (MapScreen is too heavy to mount in Jest; `asyncEventRead.guard` does the
 * same):
 *
 * - the old bottom-right ⓘ chip is gone and the corner holds the tip button;
 * - the credit stays ON the map view (OpenStreetMap's attribution guideline
 *   and Esri's terms): since 2.1.1 a small ⓘ LEFT of the scale bar, which
 *   opens the credits sheet (it replaced the #476 text caption);
 * - the tip button lives on the Map only — not on Library, Explore or Logbook.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('map corner', () => {
  const map = read('src/features/map/MapScreen.tsx');

  it('has no bottom-right attribution chip any more', () => {
    expect(map).not.toMatch(/AttributionChip/);
    expect(existsSync(join(ROOT, 'src/features/map/components/AttributionChip.tsx'))).toBe(false);
  });

  it('keeps the credit on the map: an ⓘ to the LEFT of the scale bar (2.1.1)', () => {
    expect(map).toMatch(
      /styles\.bottomSideStart\][^]*?<MapCreditsButton onPress=\{\(\) => setCreditsOpen\(true\)\} \/>\s*\{showScaleBar && scaleAt !== null && \(\s*<ScaleBar/,
    );
    // One row: the ⓘ and the scale bar side by side, bottoms aligned.
    expect(map).toMatch(/bottomSideStart: \{ flexDirection: 'row', alignItems: 'center'/);
    expect(existsSync(join(ROOT, 'src/features/map/components/MapCreditText.tsx'))).toBe(false);
    expect(map).not.toMatch(/MapCreditText/);
  });

  it('opens the credits sheet from what the map is drawing, routing included', () => {
    expect(map).toMatch(/\{creditsOpen && \(\s*<MapCreditsSheet\s+lines=\{mapCredits\(\{/);
    expect(map).toMatch(/routingEngines: drawing\.routingEngines,/);
    expect(map).toMatch(/pdfMaps: shownMaps\.map\(\(m\) => m\.name\),/);
  });

  it('puts the compass tape BELOW the ⓘ + scale row (owner 2026-10-13, #672)', () => {
    // The column lays out top to bottom: the row, then the tape, so bottom
    // up it is panel → tape → row. Without a tape NavigationCompassRow
    // renders nothing, so the column is exactly today's.
    const row = map.indexOf('style={styles.bottomRow}');
    const tape = map.indexOf('<NavigationCompassRow');
    expect(row).toBeGreaterThan(0);
    expect(tape).toBeGreaterThan(row);
    // What sits above the row measures from the row, in either order.
    expect(map).toMatch(/rowLiftAboveColumnBottom\(bottomColumnH, bottomRowY\) \+ TIP_BUBBLE_GAP/);
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
    // The only JS intervals left: the bubble's 1 s check, and the clock
    // recheck that runs only while the button is hidden for an hour.
    expect(button.match(/setInterval\(/g) ?? []).toHaveLength(2);
    expect(button).toMatch(/setInterval\(\(\) => setNow\(clock\(\)\), hideRecheckMs\)/);
    expect(button).toMatch(
      /setInterval\(\(\) => \{\s*const store = useTipMascotStore\.getState\(\)/,
    );
  });

  it('tracks the person’s own pans and zooms (for the bubble) robustly', () => {
    expect(map).toMatch(/useState\(\(\) => createGesturePause\(setCameraMoving\)\)/);
    expect(map).toMatch(
      /onRegionWillChange=\{\(e\) => \{\s*const userInteraction =\s*parseRegionPayload\(e\.nativeEvent\)\?\.userInteraction === true;\s*gesturePause\.willChange\(userInteraction\);/,
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
    // row's top (from the column's bottom edge) plus a gap, over a
    // bottom-docked info strip (#673) when there is one.
    expect(map).toMatch(/onLayout=\{\(e\) => setBottomColumnH\(e\.nativeEvent\.layout\.height\)\}/);
    expect(map).toMatch(
      /style=\{styles\.bottomRow\}[^>]*onLayout=\{\(e\) => setBottomRowY\(e\.nativeEvent\.layout\.y\)\}/,
    );
    expect(map).toMatch(
      /bottom=\{\s*stripLift \+ rowLiftAboveColumnBottom\(bottomColumnH, bottomRowY\) \+ TIP_BUBBLE_GAP\s*\}/,
    );
    // The row holds the credits ⓘ, the scale bar and the tip button.
    expect(map).toMatch(/styles\.bottomRow\}[^]*?<MapCreditsButton[^]*?<ScaleBar[^]*?<TipButton/);
  });

  it.each([
    'railMenuOpen',
    'creditsOpen',
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

describe('leaving a focused trail by tapping the map (2.1.1)', () => {
  const map = read('src/features/map/MapScreen.tsx');
  const press =
    /const handleMapPress = useCallback\([^]*?\n  const onMapPress/.exec(map)?.[0] ?? '';

  it('is decided before the dot, the area card and the point bubble', () => {
    expect(press).not.toBe('');
    const leave = press.indexOf('bareTapAfterFocus(inspectId !== null || heatSelection !== null)');
    expect(leave).toBeGreaterThan(0);
    expect(leave).toBeLessThan(press.indexOf('await tapHitsUserDot()'));
    expect(leave).toBeLessThan(press.indexOf('drawingRef.current.openAreaCard(areaId)'));
    expect(leave).toBeLessThan(press.indexOf('pointChipAfterBareTap(pointAt'));
  });

  // #745: two trails under the finger used to select nothing; now any two
  // things there (trails, areas) open the chooser, and the heatmap's hot
  // spot keeps its carousel.
  it('routes 2+ trails/areas under the finger to the overlap chooser', () => {
    const choose = press.indexOf("pick?.kind === 'choose'");
    expect(choose).toBeGreaterThan(press.indexOf('overlapAtTap('));
    expect(choose).toBeGreaterThan(press.indexOf('if (lngLatArr && heatSpot)'));
    expect(choose).toBeLessThan(
      press.indexOf('bareTapAfterFocus(inspectId !== null || heatSelection !== null)'),
    );
    expect(press.slice(choose)).toMatch(/useOverlapChooser\.getState\(\)\.open\(pick\.hits\)/);
    expect(press).toMatch(/useOverlapChooser\.getState\(\)\.close\(\)/);
  });

  it('closes the focus, forgets the camera snapshot and returns: no bubble, no glide back', () => {
    const block = /=== 'leave-focus'\) \{([^}]*)\}/.exec(press)?.[1] ?? '';
    expect(block).toContain('inspect(null);');
    expect(block).toContain('setHeatSelection(null);');
    expect(block).toContain('selectionCamera.forget();');
    expect(block).toContain('return;');
    expect(block).not.toMatch(/restore|setPointAt|setStop/);
    // The tap handler never releases the snapshot; only the two ✕ handlers
    // and the trail panel's "Follow this trail" (#678, which closes the panel
    // and leaves the camera where it is) do.
    expect(press).not.toMatch(/releaseCameraOnDeselect\(\)/);
    expect(map.match(/releaseCameraOnDeselect\(\);/g) ?? []).toHaveLength(3);
  });
});

// Owner (2.1.1): the trail panel's and carousel's ✕ leave the camera where it is.
it('the ✕ on a trail selection releases the camera snapshot instead of gliding back', () => {
  const map = readFileSync(join(__dirname, 'MapScreen.tsx'), 'utf8');
  expect(map).toMatch(/const releaseCameraOnDeselect = selectionCamera\.forget;/);
  expect(map).not.toMatch(/selectionCamera\.restore\b/);
});

// #741: the recording's photo circles answer a tap like a saved trail's: the
// photo card, through the map's tap priority (pins and the chip first).
it('the live recording photos open the photo card and ring the tapped one', () => {
  const map = readFileSync(join(__dirname, 'MapScreen.tsx'), 'utf8');
  const live = /<TrailPhotoLayers\s+id="rec-live"[^]*?\/>/.exec(map)?.[0] ?? '';
  expect(live).toContain('onPhotoPress={openRecordingPhoto}');
  expect(live).toContain('deferPress={deferPhotoPress}');
  expect(live).toContain('selectedId={recCardPhotoId}');
  expect(map).toMatch(/show\(\{ kind: 'recording', photoId: first \}\)/);
});
