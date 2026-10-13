import { act, renderHook } from '@testing-library/react-native';

import { MAP_ACTION_SNACK_MS, MAP_SNACK_MS, useMapSnackbars } from './useMapSnackbars';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const undo = () => [{ label: 'Undo', onPress: jest.fn() }];

async function setup() {
  return renderHook(() => useMapSnackbars());
}

describe('useMapSnackbars: one slot for plain messages and EDIT / UNDO', () => {
  it('shows a plain message for its own 3 s', async () => {
    const { result } = await setup();
    await act(async () => result.current.plain.show('Coordinates copied'));
    expect(result.current.plain.message).toBe('Coordinates copied');
    await act(async () => jest.advanceTimersByTime(MAP_SNACK_MS));
    expect(result.current.plain.message).toBeNull();
  });

  it('dismisses a plain message when the action bar shows', async () => {
    const { result } = await setup();
    await act(async () => result.current.plain.show('Coordinates copied'));
    await act(async () => result.current.action.show('Waypoint 3 added', undo()));
    expect(result.current.plain.message).toBeNull();
    expect(result.current.action.current?.message).toBe('Waypoint 3 added');
  });

  it('never covers EDIT / UNDO: a plain message waits for the bar to go', async () => {
    const { result } = await setup();
    await act(async () => result.current.action.show('Waypoint 3 added', undo()));
    await act(async () => result.current.plain.show('Destination set'));
    expect(result.current.plain.message).toBeNull();
    expect(result.current.action.current?.message).toBe('Waypoint 3 added');
    // The bar times out: the message that waited shows, for its full 3 s.
    await act(async () => jest.advanceTimersByTime(MAP_ACTION_SNACK_MS));
    expect(result.current.action.current).toBeNull();
    expect(result.current.plain.message).toBe('Destination set');
    await act(async () => jest.advanceTimersByTime(MAP_SNACK_MS - 1));
    expect(result.current.plain.message).toBe('Destination set');
    await act(async () => jest.advanceTimersByTime(1));
    expect(result.current.plain.message).toBeNull();
  });

  it('waits even for a message sent in the same tick as the bar', async () => {
    const { result } = await setup();
    await act(async () => {
      result.current.action.show('Moved 38 m', undo());
      result.current.plain.show('Coordinates copied');
    });
    expect(result.current.plain.message).toBeNull();
    expect(result.current.action.current).not.toBeNull();
  });

  it('shows the waiting message as soon as an action is tapped', async () => {
    const { result } = await setup();
    await act(async () => result.current.action.show('Moved 38 m', undo()));
    await act(async () => result.current.plain.show('First'));
    await act(async () => result.current.plain.show('Latest'));
    await act(async () => result.current.action.current?.actions[0]?.onPress());
    expect(result.current.action.current).toBeNull();
    // Only the latest waits: an older message is stale by then.
    expect(result.current.plain.message).toBe('Latest');
  });

  it('shows the waiting message when the bar is dismissed', async () => {
    const { result } = await setup();
    await act(async () => result.current.action.show('Moved 38 m', undo()));
    await act(async () => result.current.plain.show('Copied'));
    await act(async () => result.current.action.dismiss());
    expect(result.current.plain.message).toBe('Copied');
  });

  it('a new action bar replaces the old one and keeps the slot', async () => {
    const { result } = await setup();
    await act(async () => result.current.action.show('Waypoint 3 added', undo()));
    await act(async () => result.current.action.show('Waypoint 4 added', undo()));
    await act(async () => result.current.plain.show('Copied'));
    expect(result.current.action.current?.message).toBe('Waypoint 4 added');
    expect(result.current.plain.message).toBeNull();
  });

  it('keeps its handlers stable across renders (safe in effect dependencies)', async () => {
    const { result, rerender } = await setup();
    const { show: plainShow } = result.current.plain;
    const { show: actionShow } = result.current.action;
    await rerender({});
    await act(async () => result.current.plain.show('x'));
    expect(result.current.plain.show).toBe(plainShow);
    expect(result.current.action.show).toBe(actionShow);
  });
});
