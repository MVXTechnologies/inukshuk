import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Animated } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { HOLD_MS } from './HoldButton';
import { WaypointViewerCard, type ViewableWaypoint } from './WaypointViewerCard';

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const WITH_NOTE: ViewableWaypoint = {
  label: 'Waypoint 3',
  latitude: 46.8139,
  longitude: -71.208,
  note: 'Spring on the left of the trail.\nWater is good after rain.',
  photoUri: 'file:///photos/wp3.jpg',
};

async function setup(waypoint: ViewableWaypoint | null = WITH_NOTE) {
  const handlers = {
    onCopyCoords: jest.fn(),
    onCopyNote: jest.fn(),
    onSharePhoto: jest.fn(),
    onEdit: jest.fn(),
    onDelete: jest.fn(),
    onClose: jest.fn(),
  };
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <PaperProvider>
        <WaypointViewerCard waypoint={waypoint} {...handlers} />
      </PaperProvider>
    </SafeAreaProvider>,
  );
  return handlers;
}

// Fake timers for the whole file (the hold is a timer): toggling them per
// test breaks the next test's render.
jest.useFakeTimers();

async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe('WaypointViewerCard (#505)', () => {
  // The delete ring is JS-driven feedback; keep its frames out of the renderer.
  beforeEach(() => {
    jest.spyOn(Animated, 'timing').mockReturnValue({
      start: jest.fn(),
      stop: jest.fn(),
      reset: jest.fn(),
    } as unknown as Animated.CompositeAnimation);
  });
  afterEach(() => jest.restoreAllMocks());

  it('renders nothing without a waypoint', async () => {
    await setup(null);
    expect(screen.queryByLabelText('Delete waypoint')).toBeNull();
  });

  it('shows the note and photo straight away — no editor step', async () => {
    await setup();
    expect(screen.getByText('Waypoint 3')).toBeTruthy();
    expect(screen.getByTestId('waypoint-note')).toHaveTextContent(
      'Spring on the left of the trail. Water is good after rain.',
    );
    expect(screen.getByLabelText('View photo')).toBeTruthy();
    expect(screen.getByText('46.81390, -71.20800')).toBeTruthy();
  });

  it('shows the whole note: no line clamp (it scrolls instead)', async () => {
    await setup({ ...WITH_NOTE, note: 'line\n'.repeat(40) });
    expect(screen.getByTestId('waypoint-note').props.numberOfLines).toBeUndefined();
  });

  it('says how to add a note when there is none', async () => {
    await setup({ label: 'Waypoint 1', latitude: 46, longitude: -71 });
    expect(screen.getByText(/No note or photo yet/)).toBeTruthy();
    expect(screen.queryByLabelText('View photo')).toBeNull();
  });

  it('opens the photo full screen on tap, with Share and Close', async () => {
    const h = await setup();
    await fireEvent.press(screen.getByLabelText('View photo'));
    await fireEvent.press(screen.getByText('Share'));
    expect(h.onSharePhoto).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByLabelText('Close photo viewer'));
  });

  it('Edit opens the editor', async () => {
    const h = await setup();
    await fireEvent.press(screen.getByLabelText('Edit waypoint'));
    expect(h.onEdit).toHaveBeenCalledTimes(1);
    expect(h.onDelete).not.toHaveBeenCalled();
  });

  it('copies the note and the coordinates', async () => {
    const h = await setup();
    await fireEvent.press(screen.getByLabelText('Copy note'));
    await fireEvent.press(screen.getByLabelText('Copy coordinates'));
    expect(h.onCopyNote).toHaveBeenCalledTimes(1);
    expect(h.onCopyCoords).toHaveBeenCalledTimes(1);
  });

  it('a short press on Delete does nothing', async () => {
    const h = await setup();
    const del = screen.getByLabelText('Delete waypoint');
    await fireEvent.press(del);
    await fireEvent(del, 'pressIn');
    await wait(300);
    await fireEvent(del, 'pressOut');
    await wait(HOLD_MS * 2);
    expect(h.onDelete).not.toHaveBeenCalled();
  });

  it('a 0.8 s hold on Delete deletes', async () => {
    const h = await setup();
    await fireEvent(screen.getByLabelText('Delete waypoint'), 'pressIn');
    await wait(HOLD_MS - 50);
    expect(h.onDelete).not.toHaveBeenCalled();
    await wait(100);
    expect(h.onDelete).toHaveBeenCalledTimes(1);
  });

  it('screen readers get a named "delete" action and a hold hint', async () => {
    const h = await setup();
    const del = screen.getByLabelText('Delete waypoint');
    expect(del.props.accessibilityHint).toBe('Press and hold to delete');
    expect(del.props.accessibilityActions).toEqual(
      expect.arrayContaining([{ name: 'delete', label: 'Delete waypoint' }]),
    );
    await fireEvent(del, 'accessibilityAction', { nativeEvent: { actionName: 'delete' } });
    expect(h.onDelete).toHaveBeenCalledTimes(1);
  });
});
