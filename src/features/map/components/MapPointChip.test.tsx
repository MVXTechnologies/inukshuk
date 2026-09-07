import { fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import {
  MAP_POINT_ACTION_LABELS,
  MAP_POINT_ACTION_LAYOUT,
  MapPointChip,
  MapPointLine,
  hitMapPointChipAction,
  runMapPointChipAction,
} from './MapPointChip';

/**
 * #232 — the tapped-point chip is the hub for the two things you can do with a
 * coordinate. Its buttons are plain Views with raw responder props (a
 * Pressable inside a MapLibre marker stops the marker drawing on iOS), and
 * because Android rasterizes marker children the SAME rectangles are also
 * hit-tested at the map level. Both halves are covered here: a drift between
 * them is a button that looks pressable and does nothing.
 */
const noActions = undefined;

async function setup(actions?: {
  onNavigate: jest.Mock;
  onAddWaypoint: jest.Mock;
  onClaimTouch?: jest.Mock;
}) {
  await render(
    <PaperProvider>
      <MapPointChip accessibilityLabel="Map point readout" actions={actions}>
        <MapPointLine text="46.81390, -71.20820" />
        <MapPointLine text="Tap to copy" muted />
      </MapPointChip>
    </PaperProvider>,
  );
}

const someActions = () => ({
  onNavigate: jest.fn(),
  onAddWaypoint: jest.fn(),
  onClaimTouch: jest.fn(),
});

// The readout half is pointerEvents="none" so map taps fall through it, which
// is exactly what RNTL calls hidden.
const SHOWN = { includeHiddenElements: true } as const;

describe('MapPointChip action row', () => {
  it('offers both actions on a bare map tap', async () => {
    await setup(someActions());
    expect(screen.getByLabelText(MAP_POINT_ACTION_LABELS.navigate, SHOWN)).toBeOnTheScreen();
    expect(screen.getByLabelText(MAP_POINT_ACTION_LABELS.waypoint, SHOWN)).toBeOnTheScreen();
    expect(screen.getByText('Navigate', SHOWN)).toBeOnTheScreen();
    expect(screen.getByText('Waypoint', SHOWN)).toBeOnTheScreen();
  });

  it('still shows the readout it has always shown', async () => {
    await setup(someActions());
    expect(screen.getByText('46.81390, -71.20820', SHOWN)).toBeOnTheScreen();
    expect(screen.getByText('Tap to copy', SHOWN)).toBeOnTheScreen();
  });

  it('renders no action row at all when the caller offers no actions', async () => {
    await setup(noActions);
    expect(screen.getByText('46.81390, -71.20820', SHOWN)).toBeOnTheScreen();
    expect(screen.queryByLabelText(MAP_POINT_ACTION_LABELS.navigate, SHOWN)).toBeNull();
    expect(screen.queryByLabelText(MAP_POINT_ACTION_LABELS.waypoint, SHOWN)).toBeNull();
  });

  // One button per test: the responder release is a state update, and two in
  // one React 19 act scope overlap (which silently empties the next render).
  it('fires Navigate to coordinates when its button takes the touch', async () => {
    const a = someActions();
    await setup(a);
    press(screen.getByLabelText(MAP_POINT_ACTION_LABELS.navigate, SHOWN));
    expect(a.onNavigate).toHaveBeenCalledTimes(1);
    expect(a.onAddWaypoint).not.toHaveBeenCalled();
  });

  it('fires Add waypoint here when its button takes the touch', async () => {
    const a = someActions();
    await setup(a);
    press(screen.getByLabelText(MAP_POINT_ACTION_LABELS.waypoint, SHOWN));
    expect(a.onAddWaypoint).toHaveBeenCalledTimes(1);
    expect(a.onNavigate).not.toHaveBeenCalled();
  });

  // The claim has to land at touch-START: on iOS MapLibre's own tap
  // recognizer fires for the same tap, and the caller uses this to ignore it.
  it('claims the touch before the press, so the map can ignore the same tap', async () => {
    const a = someActions();
    await setup(a);
    const button = screen.getByLabelText(MAP_POINT_ACTION_LABELS.navigate, SHOWN);
    expect(button.props.onStartShouldSetResponder()).toBe(true);
    expect(a.onClaimTouch).toHaveBeenCalledTimes(1);
    expect(a.onNavigate).not.toHaveBeenCalled();
  });
});

/**
 * The buttons are plain Views with raw responder props, not Touchables, so
 * `fireEvent.press` has nothing to find — the release handler IS the press.
 */
function press(button: Parameters<typeof fireEvent>[0]): void {
  fireEvent(button, 'responderRelease');
}

// Offsets in screen px from the tapped coordinate, y growing downward — so
// the chip (and its row) sit at negative dy.
describe('the action row’s map-level press handling', () => {
  const { buttonWidth, buttonHeight, gap, bottomOffset } = MAP_POINT_ACTION_LAYOUT;
  const midY = -(bottomOffset + buttonHeight / 2);
  const leftX = -(gap / 2 + buttonWidth / 2);
  const rightX = gap / 2 + buttonWidth / 2;
  const actions = () => ({ onNavigate: jest.fn(), onAddWaypoint: jest.fn() });

  it('fires Navigate to coordinates for a tap on the left button, and only that', () => {
    const a = actions();
    expect(runMapPointChipAction(a, leftX, midY)).toBe(true);
    expect(a.onNavigate).toHaveBeenCalledTimes(1);
    expect(a.onAddWaypoint).not.toHaveBeenCalled();
  });

  it('fires Add waypoint here for a tap on the right button, and only that', () => {
    const a = actions();
    expect(runMapPointChipAction(a, rightX, midY)).toBe(true);
    expect(a.onAddWaypoint).toHaveBeenCalledTimes(1);
    expect(a.onNavigate).not.toHaveBeenCalled();
  });

  it('leaves a tap that misses the row to the caller', () => {
    const a = actions();
    // The gap between the buttons, the readout above, and the anchor dot below.
    expect(runMapPointChipAction(a, 0, midY)).toBe(false);
    expect(runMapPointChipAction(a, leftX, -(bottomOffset + buttonHeight) - 1)).toBe(false);
    expect(runMapPointChipAction(a, leftX, -bottomOffset + 1)).toBe(false);
    expect(runMapPointChipAction(a, leftX, 10)).toBe(false);
    expect(a.onNavigate).not.toHaveBeenCalled();
    expect(a.onAddWaypoint).not.toHaveBeenCalled();
  });

  it('ignores taps beyond either end of the row', () => {
    expect(hitMapPointChipAction(-(gap / 2 + buttonWidth) - 1, midY)).toBeNull();
    expect(hitMapPointChipAction(gap / 2 + buttonWidth + 1, midY)).toBeNull();
  });

  it('claims the row edges themselves', () => {
    expect(hitMapPointChipAction(-gap / 2, midY)).toBe('navigate');
    expect(hitMapPointChipAction(gap / 2, -bottomOffset)).toBe('waypoint');
  });
});
