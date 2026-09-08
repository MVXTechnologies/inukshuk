import { useSettingsStore } from '@state/settingsStore';
import { act, renderHook } from '@testing-library/react-native';
import { useMapBearing } from './useMapBearing';

/**
 * The MapScreen half of the rotation work (#248): what the camera's SETTLE
 * callback does with the bearing it is handed. The thresholds themselves are
 * `@core/geo/northSnap`'s business and are tested there; this covers the
 * wiring — that the badge gets a signed bearing, that a small rotation asks the
 * camera for exactly one snap, and that heading-follow is left alone.
 */
async function setup() {
  const snapToNorth = jest.fn();
  const view = await renderHook(() => useMapBearing({ snapToNorth }));
  const settle = async (bearingDeg: number) => {
    await act(async () => {
      view.result.current.onSettleBearing(bearingDeg);
    });
  };
  return { snapToNorth, view, settle };
}

describe('useMapBearing', () => {
  beforeEach(() => {
    useSettingsStore.setState({ rotateMapWithHeading: false });
  });

  it('starts north-up', async () => {
    const { view } = await setup();
    expect(view.result.current.mapBearing).toBe(0);
  });

  it('publishes the settled bearing, signed, for the badge', async () => {
    const { view, settle } = await setup();
    await settle(45);
    expect(view.result.current.mapBearing).toBe(45);
    await settle(350);
    expect(view.result.current.mapBearing).toBe(-10);
  });

  it('keeps a deliberate rotation and asks for no snap', async () => {
    const { snapToNorth, view, settle } = await setup();
    await settle(45);
    expect(snapToNorth).not.toHaveBeenCalled();
    expect(view.result.current.mapBearing).toBe(45);
  });

  it('snaps a small accidental rotation back to north', async () => {
    const { snapToNorth, settle } = await setup();
    await settle(5);
    expect(snapToNorth).toHaveBeenCalledTimes(1);
  });

  it('snaps only once — the snap own settle must not re-trigger it', async () => {
    const { snapToNorth, view, settle } = await setup();
    await settle(5);
    // The camera move ends in another settle, on the bearing it landed on.
    await settle(0);
    expect(snapToNorth).toHaveBeenCalledTimes(1);
    expect(view.result.current.mapBearing).toBe(0);
  });

  it('does not re-enter even if the settle echoes the same crooked bearing', async () => {
    const { snapToNorth, settle } = await setup();
    await settle(5);
    await settle(5);
    await settle(4.9);
    expect(snapToNorth).toHaveBeenCalledTimes(1);
  });

  it('re-arms for a later gesture once the snap window has passed', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const { snapToNorth, settle } = await setup();
      await settle(5);
      expect(snapToNorth).toHaveBeenCalledTimes(1);
      now.mockReturnValue(1_000 + 5_000);
      await settle(6);
      expect(snapToNorth).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('does not snap while the map already sits at north', async () => {
    const { snapToNorth, settle } = await setup();
    await settle(0);
    await settle(0.5);
    expect(snapToNorth).not.toHaveBeenCalled();
  });

  it('leaves the bearing alone under heading-follow — the compass owns it', async () => {
    useSettingsStore.setState({ rotateMapWithHeading: true });
    const { snapToNorth, view, settle } = await setup();
    await settle(5);
    expect(snapToNorth).not.toHaveBeenCalled();
    // The badge still learns the bearing: under heading-follow the red needle
    // is the only north reference on screen.
    expect(view.result.current.mapBearing).toBe(5);
  });

  it('starts snapping again as soon as heading-follow is switched off', async () => {
    useSettingsStore.setState({ rotateMapWithHeading: true });
    const { snapToNorth, view, settle } = await setup();
    await settle(5);
    expect(snapToNorth).not.toHaveBeenCalled();
    await act(async () => {
      useSettingsStore.setState({ rotateMapWithHeading: false });
    });
    await settle(5);
    expect(snapToNorth).toHaveBeenCalledTimes(1);
    expect(view.result.current.mapBearing).toBe(5);
  });
});
