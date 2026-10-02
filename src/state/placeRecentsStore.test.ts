import type { Place } from '@core/search/place';
import { usePlaceRecentsStore } from './placeRecentsStore';

const mockSave = jest.fn();
let mockStored: Place[] = [];
jest.mock('@data/placeSearch', () => ({
  loadPlaceRecents: () => Promise.resolve(mockStored),
  savePlaceRecents: (list: unknown) => mockSave(list) as unknown,
}));

const p = (id: string): Place => ({
  id,
  source: 'index',
  type: 'peak',
  name: id,
  latitude: 47,
  longitude: -71,
});

beforeEach(() => {
  mockSave.mockReset();
  mockStored = [];
  usePlaceRecentsStore.setState({ recents: [], hydrated: false });
});

describe('placeRecentsStore', () => {
  it('hydrates from disk once', async () => {
    mockStored = [p('a'), p('b')];
    await usePlaceRecentsStore.getState().hydrate();
    await usePlaceRecentsStore.getState().hydrate();
    expect(usePlaceRecentsStore.getState().recents.map((x) => x.id)).toEqual(['a', 'b']);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('saves each pick after hydration, newest first', async () => {
    await usePlaceRecentsStore.getState().hydrate();
    usePlaceRecentsStore.getState().push(p('a'));
    usePlaceRecentsStore.getState().push(p('b'));
    usePlaceRecentsStore.getState().push(p('a'));
    expect(mockSave).toHaveBeenLastCalledWith([p('a'), p('b')]);
  });

  it('never overwrites the file with a pick made before it was read', async () => {
    mockStored = [p('old')];
    usePlaceRecentsStore.getState().push(p('early'));
    expect(mockSave).not.toHaveBeenCalled();
    await usePlaceRecentsStore.getState().hydrate();
    expect(usePlaceRecentsStore.getState().recents.map((x) => x.id)).toEqual(['early', 'old']);
    expect(mockSave).toHaveBeenCalledWith([p('early'), p('old')]);
  });

  it('clears', async () => {
    await usePlaceRecentsStore.getState().hydrate();
    usePlaceRecentsStore.getState().push(p('a'));
    usePlaceRecentsStore.getState().clear();
    expect(usePlaceRecentsStore.getState().recents).toEqual([]);
    expect(mockSave).toHaveBeenLastCalledWith([]);
  });
});
