/**
 * The map's overlay order (`overlayOrder.ts`), pinned at the source level
 * (MapScreen is too heavy to mount in Jest; `mapCorner.guard` does the
 * same). React Native stacks siblings by zIndex, then by tree order; the
 * info strip has no zIndex, so "below every overlay" means: mounted before
 * each of them, and none of them below zIndex 0.
 *
 * The 2.6.0 review's P0 was a strip at zIndex 4 drawing over the "What are
 * you recording?" sheet's Start button. Each sibling overlay is listed here;
 * a new one adds a line to `ABOVE_THE_STRIP` (2.5.2's team drawing mode and
 * cluster sheet did).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BOTTOM_LAYER, waypointCardDockStyle } from './bottomLayers';
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
  'team bar': '<TeamStatusBar',
  'team overlay': '<TeamMapOverlay',
  'team pick': '<TeamPickOverlay',
  'team drawing mode': '<TeamDrawMode',
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

describe('2.5.2 × 2.6.0: team drawing and the cluster sheet in the one order', () => {
  const drawMode = read('src/features/team/draw/TeamDrawMode.tsx');

  it('drawing mode takes its slot from the table: over the snackbars, its credits sheet over it', () => {
    expect(BOTTOM_LAYER.drawMode.zIndex).toBe(MAP_OVERLAY_Z.drawingMode);
    expect(BOTTOM_LAYER.overDrawMode.zIndex).toBe(MAP_OVERLAY_Z.overDrawMode);
    expect(MAP_OVERLAY_Z.drawingMode).toBeGreaterThan(MAP_OVERLAY_Z.snackbar);
    expect(MAP_OVERLAY_Z.drawingMode).toBeGreaterThan(MAP_OVERLAY_Z.recordingPanel);
    expect(MAP_OVERLAY_Z.overDrawMode).toBeGreaterThan(MAP_OVERLAY_Z.drawingMode);
    // Its OUTERMOST view carries the slot (the inner zIndexes stack inside it).
    expect(drawMode).toMatch(
      /return \(\s*<View\s+style=\{\[StyleSheet\.absoluteFill, BOTTOM_LAYER\.drawMode\]\}/,
    );
    // The credits sheet opened from it is mounted after it, on the slot above.
    expect(map.indexOf('<MapCreditsSheet')).toBeGreaterThan(map.indexOf('<TeamDrawMode'));
    expect(map).toMatch(/teamDrawing \? \{ layer: BOTTOM_LAYER\.overDrawMode \}/);
  });

  it('drawing mode hides the strip, so the draw-mode credits sheet owes it no lift', () => {
    expect(map).toMatch(/hidden=\{selecting \|\| makeMapState !== null \|\| stripStepsAside\}/);
    expect(map).toMatch(/const stripStepsAside = teamDrawing \|\| movingWp !== null;/);
    expect(map).toMatch(/const stripLift = stripStepsAside \? 0 : measuredStripLift;/);
    // In drawing mode the sheet sits over the draw tool bar; elsewhere on the
    // column, which sits on the strip.
    expect(map).toMatch(
      /teamDrawing\s*\? drawCreditsSheetBottom\(insets\.bottom, recordingPanelUp \? panelHeight : 0\)\s*: bottomColumnLift \+\s*stripLift \+/,
    );
  });

  it('the team button and the EDIT / UNDO bar clear the strip as well as the column', () => {
    expect(map).toMatch(
      /fabBottom=\{teamFabBottom\(bottomColumnLift \+ stripLift, bottomColumnH\)\}/,
    );
    expect(map).toMatch(/liftedSnackbarStyle\(bottomColumnLift \+ stripLift, bottomColumnH\)/);
  });

  it('every bottom card (the cluster sheet among them) docks on the strip, above it in z', () => {
    expect(MAP_OVERLAY_Z.waypointCard).toBeGreaterThan(MAP_OVERLAY_Z.infoStrip);
    // No card dock in MapScreen forgets the strip.
    const docks = map.match(/waypointCardDockStyle\([^)]*\)/g) ?? [];
    expect(docks.length).toBeGreaterThanOrEqual(7);
    for (const d of docks) expect(d).toMatch(/, stripLift\)$/);
    // The cluster sheet sits in that dock, after the strip, and only while the
    // bottom-card slot is free (drawing modes, an edit, an inspection, a move).
    const cluster = map.indexOf('<WaypointClusterSheet');
    const dock = map.lastIndexOf('waypointCardDockStyle(', cluster);
    expect(map.slice(dock, cluster)).toMatch(
      /^waypointCardDockStyle\(recordingPanelUp, panelHeight, stripLift\)/,
    );
    expect(map.slice(map.lastIndexOf('{cardSlotFree', cluster), cluster)).toMatch(
      /^\{cardSlotFree && movingWp === null && \(/,
    );
    expect(map).toMatch(/bottomCardSlotFree\(\{[^}]*teamDrawing,?\s*\}\)/);
  });

  it('a card docked on a 52 dp strip neither covers it nor leaves it under the card', () => {
    // Idle: the card's bottom edge is the strip's top edge.
    expect(waypointCardDockStyle(false, 0, 52)).toMatchObject({ bottom: 52, left: 0, right: 0 });
    // Recording: the strip sits on the panel, the card floats over both.
    expect(waypointCardDockStyle(true, 240, 52).bottom).toBe(240 + 52 + 8);
    // No strip (hidden, or at the top): 2.5.2's dock exactly.
    expect(waypointCardDockStyle(true, 240, 0).bottom).toBe(240 + 8);
    expect(waypointCardDockStyle(false, 240)).toMatchObject({ bottom: 0 });
  });
});

describe('2.5.2 MapImages: the strip registers no map sprites of its own', () => {
  it('the centre cursor and the strip are views, never a MapLibre <Images>', () => {
    const { readdirSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
    const dir = 'src/features/map/infoStrip';
    const files = [
      'src/features/map/components/CenterCursor.tsx',
      ...readdirSync(join(ROOT, dir), { recursive: true })
        .map(String)
        .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
        .map((f) => `${dir}/${f}`),
    ];
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const src = read(file);
      expect({ file, images: /<Images\b|\bImages\b[^;]*from '@maplibre/.test(src) }).toEqual({
        file,
        images: false,
      });
    }
  });

  it("MapScreen's one sprite registration is <MapImages />, the map's first child", () => {
    expect(map.match(/<MapImages \/>/g)).toHaveLength(1);
    expect(map).not.toMatch(/<Images\b/);
    // First inside <Map>: only a comment before it, the camera right after.
    expect(map).toMatch(/<Map\b[^]*?\n {10}>\s*(\{\/\*[^]*?\*\/\}\s*)?<MapImages \/>\s*<Camera\b/);
  });
});
