/**
 * Drop-target bookkeeping in the Library drag (#303, audit A23).
 *
 * The shipped bug: a folder header's rectangle stayed cached after its View
 * unmounted (folder deleted), so a later drop landing where that header used
 * to be resolved to the DELETED folder id — the stale rect was hit-tested
 * first, and the drop reported "Moved to …" while the item quietly fell into
 * Ungrouped. These tests drive the real hook through its responder callbacks
 * with fake measurable views, so they pin the hook's own bookkeeping rather
 * than PanResponder's gesture maths.
 */
import { act, renderHook } from '@testing-library/react-native';
import { PanResponder, type GestureResponderEvent, type View } from 'react-native';

import { useDragToFolder, type DragItem } from './useDragToFolder';

type Rect = { x: number; y: number; w: number; h: number };
type MeasureCb = (x: number, y: number, w: number, h: number) => void;

/** A stand-in for a header View: measures synchronously unless `defer` holds the callback. */
function fakeView(rect: Rect, deferred?: MeasureCb[]): View {
  return {
    measureInWindow: (cb: MeasureCb) => {
      if (deferred) deferred.push(() => cb(rect.x, rect.y, rect.w, rect.h));
      else cb(rect.x, rect.y, rect.w, rect.h);
    },
  } as unknown as View;
}

interface Handlers {
  onPanResponderGrant: (e: GestureResponderEvent) => void;
  onPanResponderMove: (e: GestureResponderEvent, g: { dx: number; dy: number }) => void;
  onPanResponderRelease: (e: GestureResponderEvent) => void;
}

const at = (pageX: number, pageY: number) =>
  ({ nativeEvent: { pageX, pageY } }) as unknown as GestureResponderEvent;

const item: DragItem = { kind: 'track', id: 't1', label: 'Morning run' };

beforeEach(() => {
  // Hand the hook's responder config straight back so the test can call the
  // grant/move/release callbacks with plain events.
  jest
    .spyOn(PanResponder, 'create')
    .mockImplementation((config) => ({ panHandlers: config as never }));
});

async function setup() {
  const onDrop = jest.fn<void, [DragItem, string | null]>();
  const hook = await renderHook(() => useDragToFolder({ onDrop }));
  const handlers = hook.result.current.handleProps(item) as unknown as Handlers;
  const drag = (x: number, y: number) =>
    act(() => {
      handlers.onPanResponderGrant(at(x, y));
      handlers.onPanResponderMove(at(x, y), { dx: 10, dy: 10 });
    });
  const release = (x: number, y: number) => act(() => handlers.onPanResponderRelease(at(x, y)));
  return { onDrop, hook, drag, release };
}

describe('useDragToFolder drop targets', () => {
  it('forgets a deleted folder so the folder now in its place receives the drop', async () => {
    const { onDrop, hook, drag, release } = await setup();
    const { registerTarget } = hook.result.current;
    const top: Rect = { x: 0, y: 0, w: 300, h: 50 };
    const below: Rect = { x: 0, y: 60, w: 300, h: 50 };
    registerTarget('deleted')(fakeView(top));
    registerTarget('survivor')(fakeView(below));

    await drag(10, 25);
    await release(10, 25);
    expect(onDrop).toHaveBeenLastCalledWith(item, 'deleted');

    // The user deletes the top folder; the survivor's header shifts up into
    // that position (React unmounts the old View, re-measures the new one).
    registerTarget('deleted')(null);
    registerTarget('survivor')(fakeView(top));

    await drag(10, 25);
    await release(10, 25);
    expect(onDrop).toHaveBeenLastCalledWith(item, 'survivor');
    expect(onDrop).toHaveBeenCalledTimes(2);
  });

  it('ignores a measurement that lands after its header was unregistered', async () => {
    const { onDrop, hook, drag, release } = await setup();
    const { registerTarget } = hook.result.current;
    const pending: MeasureCb[] = [];
    registerTarget('deleted')(fakeView({ x: 0, y: 0, w: 300, h: 50 }, pending));

    await drag(10, 25); // measureTargets() ran; the native callback is still in flight
    registerTarget('deleted')(null);
    for (const cb of pending) cb(0, 0, 0, 0);

    await release(10, 25);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('does not commit a drop onto a target unregistered mid-drag', async () => {
    const { onDrop, hook, drag, release } = await setup();
    const { registerTarget } = hook.result.current;
    registerTarget('gone')(fakeView({ x: 0, y: 0, w: 300, h: 50 }));

    await drag(10, 25);
    registerTarget('gone')(null);
    await release(10, 25);
    expect(onDrop).not.toHaveBeenCalled();
    expect(hook.result.current.dragging).toBeNull();
  });
});
