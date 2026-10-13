import { useNavigationStore } from './navigationStore';

const A = { latitude: 46.8, longitude: -71.2 };

beforeEach(() => useNavigationStore.setState({ destination: null, following: null }));

describe('navigationStore: one navigation at a time', () => {
  it('navigating to a point stops following a trail', () => {
    useNavigationStore.getState().follow({ trackId: 't1', name: 'Ridge' });
    useNavigationStore.getState().setDestination(A);
    expect(useNavigationStore.getState()).toMatchObject({ destination: A, following: null });
  });

  it('following a trail clears the destination', () => {
    useNavigationStore.getState().setDestination(A);
    useNavigationStore.getState().follow({ trackId: 't1', name: 'Ridge' });
    expect(useNavigationStore.getState()).toMatchObject({
      destination: null,
      following: { trackId: 't1', name: 'Ridge' },
    });
  });

  it('clearing the destination leaves a followed trail alone', () => {
    useNavigationStore.getState().follow({ trackId: 't1', name: 'Ridge' });
    useNavigationStore.getState().setDestination(null);
    expect(useNavigationStore.getState().following).not.toBeNull();
  });

  it('stops following', () => {
    useNavigationStore.getState().follow({ trackId: 't1', name: 'Ridge' });
    useNavigationStore.getState().stopFollowing();
    expect(useNavigationStore.getState().following).toBeNull();
  });
});
