import { fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import {
  MAP_POINT_ACTION_LABELS,
  MAP_POINT_ACTION_LAYOUT,
  MAP_POINT_COPY_HIT,
  MapPointChip,
  MapPointLine,
  hitMapPointChip,
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
  onConvert: jest.Mock;
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
  onConvert: jest.fn(),
  onClaimTouch: jest.fn(),
});

// The readout half is pointerEvents="none" so map taps fall through it, which
// is exactly what RNTL calls hidden.
const SHOWN = { includeHiddenElements: true } as const;

describe('MapPointChip action row', () => {
  it('offers the three actions on a bare map tap', async () => {
    await setup(someActions());
    expect(screen.getByLabelText(MAP_POINT_ACTION_LABELS.navigate, SHOWN)).toBeOnTheScreen();
    expect(screen.getByLabelText(MAP_POINT_ACTION_LABELS.waypoint, SHOWN)).toBeOnTheScreen();
    expect(screen.getByLabelText(MAP_POINT_ACTION_LABELS.convert, SHOWN)).toBeOnTheScreen();
    expect(screen.getByText('Navigate', SHOWN)).toBeOnTheScreen();
    expect(screen.getByText('Waypoint', SHOWN)).toBeOnTheScreen();
    expect(screen.getByText('Convert', SHOWN)).toBeOnTheScreen();
  });

  it('fires Convert coordinates when its button takes the touch', async () => {
    const a = someActions();
    await setup(a);
    press(screen.getByLabelText(MAP_POINT_ACTION_LABELS.convert, SHOWN));
    expect(a.onConvert).toHaveBeenCalledTimes(1);
    expect(a.onNavigate).not.toHaveBeenCalled();
  });

  it('fits three buttons inside the chip’s 240 px (10 px padding each side)', () => {
    const { buttonWidth, gap } = MAP_POINT_ACTION_LAYOUT;
    expect(3 * buttonWidth + 2 * gap).toBeLessThanOrEqual(240 - 2 * 10);
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
  // Three buttons centred on the coordinate: left, middle, right.
  const leftX = -(buttonWidth + gap);
  const midX = 0;
  const rightX = buttonWidth + gap;
  const rowEdge = (3 * buttonWidth + 2 * gap) / 2;
  const actions = () => ({ onNavigate: jest.fn(), onAddWaypoint: jest.fn(), onConvert: jest.fn() });

  it('fires Navigate to coordinates for a tap on the left button, and only that', () => {
    const a = actions();
    expect(runMapPointChipAction(a, leftX, midY)).toBe(true);
    expect(a.onNavigate).toHaveBeenCalledTimes(1);
    expect(a.onAddWaypoint).not.toHaveBeenCalled();
    expect(a.onConvert).not.toHaveBeenCalled();
  });

  it('fires Add waypoint here for a tap on the middle button, and only that', () => {
    const a = actions();
    expect(runMapPointChipAction(a, midX, midY)).toBe(true);
    expect(a.onAddWaypoint).toHaveBeenCalledTimes(1);
    expect(a.onNavigate).not.toHaveBeenCalled();
  });

  it('fires Convert coordinates for a tap on the right button, and only that', () => {
    const a = actions();
    expect(runMapPointChipAction(a, rightX, midY)).toBe(true);
    expect(a.onConvert).toHaveBeenCalledTimes(1);
    expect(a.onAddWaypoint).not.toHaveBeenCalled();
  });

  it('leaves a tap that misses the row to the caller', () => {
    const a = actions();
    // A gap between buttons, the readout above, and the anchor dot below.
    expect(runMapPointChipAction(a, -(buttonWidth / 2 + gap / 2), midY)).toBe(false);
    expect(runMapPointChipAction(a, leftX, -(bottomOffset + buttonHeight) - 1)).toBe(false);
    expect(runMapPointChipAction(a, leftX, -bottomOffset + 1)).toBe(false);
    expect(runMapPointChipAction(a, leftX, 10)).toBe(false);
    expect(a.onNavigate).not.toHaveBeenCalled();
    expect(a.onAddWaypoint).not.toHaveBeenCalled();
    expect(a.onConvert).not.toHaveBeenCalled();
  });

  it('ignores taps beyond either end of the row', () => {
    expect(hitMapPointChipAction(-rowEdge - 1, midY)).toBeNull();
    expect(hitMapPointChipAction(rowEdge + 1, midY)).toBeNull();
  });

  it('claims the row edges themselves', () => {
    expect(hitMapPointChipAction(-rowEdge, midY)).toBe('navigate');
    expect(hitMapPointChipAction(-buttonWidth / 2, -bottomOffset)).toBe('waypoint');
    expect(hitMapPointChipAction(rowEdge, midY)).toBe('convert');
  });
});

describe('hitMapPointChip', () => {
  const { buttonWidth, buttonHeight, gap, bottomOffset } = MAP_POINT_ACTION_LAYOUT;
  const midY = -(bottomOffset + buttonHeight / 2);

  it('names the button a tap lands on, ahead of the copy circle around it', () => {
    expect(hitMapPointChip(-(buttonWidth + gap), midY)).toBe('navigate');
    expect(hitMapPointChip(0, midY)).toBe('waypoint');
    expect(hitMapPointChip(buttonWidth + gap, midY)).toBe('convert');
  });

  it('reads a tap on the readout or the anchor dot as copy', () => {
    // Just above the action row (the readout lines), and on the anchor dot.
    const { buttonHeight, bottomOffset } = MAP_POINT_ACTION_LAYOUT;
    expect(hitMapPointChip(0, -(bottomOffset + buttonHeight) - 4)).toBe('copy');
    expect(hitMapPointChip(0, 0)).toBe('copy');
    expect(MAP_POINT_COPY_HIT.radius).toBeGreaterThan(0);
  });

  it('is not a chip tap anywhere else', () => {
    expect(hitMapPointChip(0, MAP_POINT_COPY_HIT.radius)).toBeNull();
    expect(hitMapPointChip(200, 0)).toBeNull();
  });
});
