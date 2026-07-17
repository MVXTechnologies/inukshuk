import { useMapStore } from './mapStore';

describe('mapStore focusWaypoint intent', () => {
  afterEach(() => {
    useMapStore.setState({ focusWaypoint: null });
  });

  it('starts with no pending intent', () => {
    expect(useMapStore.getState().focusWaypoint).toBeNull();
  });

  it('setFocusWaypoint stores the target position', () => {
    useMapStore.getState().setFocusWaypoint({ latitude: 46.81, longitude: -71.21 });
    expect(useMapStore.getState().focusWaypoint).toEqual({ latitude: 46.81, longitude: -71.21 });
  });

  it('is cleared by setting null (one-shot consumption)', () => {
    const { setFocusWaypoint } = useMapStore.getState();
    setFocusWaypoint({ latitude: 1, longitude: 2 });
    setFocusWaypoint(null);
    expect(useMapStore.getState().focusWaypoint).toBeNull();
  });
});
