/**
 * How MapScreen wires the info strip (#673), pinned at the source level
 * (MapScreen is too heavy to mount in Jest; `mapCorner.guard` does the
 * same). The behaviour behind each line is tested on the components
 * (InfoStripHost, InfoStripInsets, RecordingPanel); this pins the few lines
 * that put them together, in the owner's order, bottom up: the tab bar or
 * recording panel, the strip, the compass tape, the ⓘ + scale row.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('MapScreen ↔ info strip', () => {
  const map = read('src/features/map/MapScreen.tsx');

  it('mounts the strip on the bottom column lift (tab bar edge, recording panel, sheets)', () => {
    expect(map).toMatch(/<InfoStripHost[^>]*bottomLift=\{bottomColumnLift\}/);
    expect(map).toMatch(/hidden=\{selecting \|\| makeMapState !== null\}/);
    // MapScreen hands over what it already holds per fix: no new subscription.
    expect(map).toMatch(
      /<InfoStripHost\s+location=\{location\}\s+fix=\{lastFix\}\s+follow=\{follow\}/,
    );
  });

  it('lifts the bottom column (the scale row over the tape) by the measured strip', () => {
    expect(map).toMatch(/const stripLift = useInfoStripBottomLift\(\);/);
    expect(map).toMatch(/stripLift > 0 && \{ bottom: bottomColumnLift \+ stripLift \}/);
    // The tape stays below the row inside that column (same rule as 2.5.1).
    expect(map.indexOf('<NavigationCompassRow')).toBeGreaterThan(
      map.indexOf('style={styles.bottomRow}'),
    );
    // The credits sheet and the tip bubble ride on it too.
    expect(map).toMatch(/bottomColumnLift \+\s*stripLift \+/);
  });

  it('has no 2.5.1 coordinates chip left: the strip is its home', () => {
    expect(map).not.toMatch(/CenterCoordinatesChip|onChipRowLayout|onTipSlotLayout/);
    expect(existsSync(join(ROOT, 'src/features/map/components/CenterCoordinatesChip.tsx'))).toBe(
      false,
    );
  });

  it('the destination chip is the name and ✕ (the strip carries the numbers)', () => {
    expect(map).toMatch(/<DestinationChip onClear=\{\(\) => setDestination\(null\)\} \/>/);
  });

  it('the top dock: the Map route reads its safe area through InfoStripInsets', () => {
    const route = read('app/(tabs)/index.tsx');
    expect(route).toMatch(/<InfoStripInsets>\s*<MapScreen \/>\s*<\/InfoStripInsets>/);
    // MapScreen's top chrome is placed from that safe area.
    expect(map).toMatch(/const insets = useSafeAreaInsets\(\);/);
    expect(map).toMatch(/\{ top: insets\.top \+ 8 \}/);
  });
});
