/**
 * The map's overlay order (`overlayOrder.ts`), pinned at the source level
 * (MapScreen is too heavy to mount in Jest; `mapCorner.guard` does the
 * same). React Native stacks siblings by zIndex, then by tree order; the
 * info strip has no zIndex, so "below every overlay" means: mounted before
 * each of them, and none of them below zIndex 0.
 *
 * The 2.6.0 review's P0 was a strip at zIndex 4 drawing over the "What are
 * you recording?" sheet's Start button. Each sibling overlay is listed here;
 * a new one (2.5.2's drawing mode) adds a line to `ABOVE_THE_STRIP`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MAP_OVERLAY_Z } from './overlayOrder';

const ROOT = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const map = read('src/features/map/MapScreen.tsx');

/** Every sibling MapScreen draws over the map, by a marker unique to its mount. */
const ABOVE_THE_STRIP: Record<string, string> = {
  'region select': '<RegionSelectOverlay',
  'map maker': '<MapMakerEditor',
  'compass badge': '<CompassBadge',
  'search sheet': '<PlaceSearchSheet',
  'controls rail': '<MapControlsRail',
  'bottom column': 'style={styles.bottomRow}',
  'shown trail sheet': '<ShownTrailSheet',
  'trail inspector': '<TrailInspectPanel',
  'night veil': 'NIGHT_MAP.veil',
  'glove shield': 'recordingPanelUp && gloveLocked && (',
  'recording panel': '<RecordingPanel',
  'receiver chip': '<ReceiverMapOverlay',
  'team overlay': '<TeamMapOverlay',
  'team pick': '<TeamPickOverlay',
  'photo card': '<PhotoBottomCard',
  'heat carousel': '<HeatPointCarousel',
  'tip bubble': '<TipBubble',
  'credits sheet': '<MapCreditsSheet',
  'category sheet': '<CategoryStartSheet',
  'background rationale': '<BackgroundLocationRationale',
  'recording check': '<RecordingCheckPanel',
  'drawing chrome': '{drawing.chrome}',
  'waypoint card': '<WaypointViewerCard',
  'cluster sheet': '<WaypointClusterSheet',
  'extension card': '<ExtensionCardDock',
  'forecast card': '<ForecastCard',
  'move overlay': '<MoveWaypointOverlay',
  'waypoint editor': '<WaypointEditorSheet',
  snackbars: '<ActionSnackbar',
};

describe('the info strip is the lowest overlay', () => {
  const strip = map.indexOf('<InfoStripHost');

  it('is mounted once, right after the map and its centre cursor', () => {
    expect(strip).toBeGreaterThan(0);
    expect(map.indexOf('<InfoStripHost', strip + 1)).toBe(-1);
    expect(strip).toBeGreaterThan(map.indexOf('</Map>'));
    expect(strip).toBeGreaterThan(map.indexOf('<CenterCursor'));
  });

  it.each(Object.entries(ABOVE_THE_STRIP))(
    'is below the %s (mounted after it)',
    (_name, marker) => {
      const at = map.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(strip);
    },
  );

  it('no layer of the order goes under it', () => {
    for (const [layer, z] of Object.entries(MAP_OVERLAY_Z)) {
      expect({ layer, below: z < MAP_OVERLAY_Z.infoStrip }).toEqual({ layer, below: false });
    }
    expect(MAP_OVERLAY_Z.infoStrip).toBe(0);
    // Nothing on the map screen reaches under zIndex 0.
    expect(map).not.toMatch(/zIndex:\s*-/);
  });

  it('the overlays take their zIndex from the one table', () => {
    for (const file of [
      'src/features/map/bottomLayers.ts',
      'src/features/map/longTrail/ShownTrailChrome.tsx',
      'src/features/gnss/ReceiverMapOverlay.tsx',
      'src/features/map/waypoints/MoveWaypointOverlay.tsx',
      'src/features/team/map/TeamPick.tsx',
      'src/features/map/components/HeatPointCarousel.tsx',
      'src/features/map/waypoints/WaypointEditorSheet.tsx',
      'src/features/recording/RecordingCheckPanel.tsx',
      'src/features/map/components/BackgroundLocationRationale.tsx',
      'src/features/map/infoStrip/editor/InfoStripEditor.tsx',
    ]) {
      const src = read(file);
      expect({ file, table: src.includes('MAP_OVERLAY_Z.') }).toEqual({ file, table: true });
      expect({ file, literal: /zIndex:\s*\d/.test(src) }).toEqual({ file, literal: false });
    }
    expect(map).toMatch(/searchSheet: \{[^}]*zIndex: MAP_OVERLAY_Z\.searchSheet/);
    expect(map).toMatch(/topCenterChip: \{[^}]*zIndex: MAP_OVERLAY_Z\.topChip/);
  });

  it('the strip host itself carries no zIndex', () => {
    const host = read('src/features/map/infoStrip/InfoStripHost.tsx');
    expect(host).not.toMatch(/zIndex:|elevation:/);
  });
});

describe('what sits with the strip (the review)', () => {
  it('the glove shield covers it: the shield comes after the strip, the panel after the shield', () => {
    const strip = map.indexOf('<InfoStripHost');
    const shield = map.indexOf('recordingPanelUp && gloveLocked && (');
    expect(shield).toBeGreaterThan(strip);
    expect(map.indexOf('<RecordingPanel')).toBeGreaterThan(shield);
  });

  it('the trail inspector covers the bottom edge: a bottom-docked strip steps aside', () => {
    expect(map).toMatch(/<InfoStripHost[^>]*bottomSheetUp=\{inspectId !== null\}/);
  });

  it('the EDIT / UNDO bar clears the strip as well as the column', () => {
    expect(map).toMatch(/liftedSnackbarStyle\(bottomColumnLift \+ stripLift, bottomColumnH\)/);
  });

  it("the editor is modal: the map leaves the screen reader's reach, Back is the screen's", () => {
    expect(map).toMatch(
      /importantForAccessibility=\{stripEditorOpen \? 'no-hide-descendants' : 'auto'\}/,
    );
    expect(map).toMatch(/accessibilityElementsHidden=\{stripEditorOpen\}/);
    expect(map).toMatch(/<InfoStripHost[^>]*focused=\{isFocused\}/);
  });

  it("the copy's confirmation carries Convert", () => {
    expect(map).toMatch(/<InfoStripHost[^>]*onCopied=\{onStripCopied\}/);
    expect(map).toMatch(/label: 'Convert', onPress: convert/);
  });
});
