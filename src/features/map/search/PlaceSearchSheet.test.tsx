import type { Place } from '@core/search/place';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useLibraryStore } from '@state/libraryStore';
import { usePlaceRecentsStore } from '@state/placeRecentsStore';
import { useSettingsStore } from '@state/settingsStore';
import { PlaceSearchSheet } from './PlaceSearchSheet';

/**
 * The map's place search (#496): typing → debounced index request → ranked
 * rows → a tap hands the place to the map; coordinates answered locally and
 * first; recents; and the on-device fallback when the index is unreachable
 * or "Locally downloaded only" is on.
 */

const mockFetchPlaces = jest.fn();
const mockSave = jest.fn();
let mockStoredRecents: unknown[] = [];

jest.mock('@data/placeSearch', () => {
  class PlaceSearchError extends Error {
    reason: string;
    constructor(why: string) {
      super(why);
      this.reason = why;
    }
  }
  return {
    PlaceSearchError,
    fetchPlaces: (...args: unknown[]) => mockFetchPlaces(...args) as unknown,
    loadPlaceRecents: () => Promise.resolve(mockStoredRecents),
    savePlaceRecents: (...args: unknown[]) => mockSave(...args) as unknown,
  };
});

const QUEBEC = { latitude: 46.81, longitude: -71.21 };

const KATAHDIN: Place = {
  id: 'osm:N1',
  source: 'index',
  type: 'peak',
  name: 'Katahdin',
  latitude: 45.9044,
  longitude: -68.9213,
  context: 'Maine, United States',
  elevationM: 1606,
};

const KATAHDIN_LAKE: Place = {
  id: 'osm:W2',
  source: 'index',
  type: 'lake',
  name: 'Katahdin Lake',
  latitude: 45.92,
  longitude: -68.83,
  bbox: [-68.85, 45.91, -68.81, 45.93],
  context: 'Maine, United States',
};

async function renderSheet(
  over: Partial<{ origin: typeof QUEBEC | null; onSelect: jest.Mock; onClose: jest.Mock }> = {},
) {
  const onSelect = over.onSelect ?? jest.fn();
  const onClose = over.onClose ?? jest.fn();
  await render(
    <PlaceSearchSheet
      origin={over.origin === undefined ? QUEBEC : over.origin}
      bias={null}
      onSelect={onSelect}
      onClose={onClose}
    />,
  );
  // Let the recents hydration settle.
  await act(async () => {});
  return { onSelect, onClose };
}

async function type(text: string) {
  await act(async () => {
    fireEvent.changeText(screen.getByLabelText('Search places'), text);
  });
}

/** Run the 250 ms debounce and let the request's promise resolve. */
async function settle() {
  await act(async () => {
    jest.advanceTimersByTime(250);
  });
  await act(async () => {});
}

beforeEach(() => {
  jest.useFakeTimers();
  mockFetchPlaces.mockReset();
  mockSave.mockReset();
  mockStoredRecents = [];
  usePlaceRecentsStore.setState({ recents: [], hydrated: false });
  useLibraryStore.setState({ waypoints: [], tracks: [], maps: [] });
});

afterEach(async () => {
  jest.useRealTimers();
  await act(async () => {
    useSettingsStore.getState().reset();
  });
});

describe('PlaceSearchSheet', () => {
  it('explains itself when empty, with no recents yet', async () => {
    await renderSheet();
    expect(screen.getByText(/Find towns, villages, peaks, lakes, campgrounds/)).toBeTruthy();
    expect(mockFetchPlaces).not.toHaveBeenCalled();
  });

  it('searches as you type, once, 250 ms after the last keystroke', async () => {
    mockFetchPlaces.mockResolvedValue([KATAHDIN_LAKE, KATAHDIN]);
    const { onSelect } = await renderSheet();

    await type('K');
    expect(screen.getByText('Keep typing…')).toBeTruthy();
    await type('Kat');
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    await type('Katahdin');
    await settle();

    expect(mockFetchPlaces).toHaveBeenCalledTimes(1);
    expect(mockFetchPlaces).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Katahdin', near: QUEBEC }),
    );
    // The exact-name peak outranks the lake that only starts with it.
    const rows = screen.getAllByRole('button', { name: /Katahdin/ });
    expect(rows[0]?.props.accessibilityLabel).toMatch(/^Katahdin, Peak · 1.?606 m, Maine/);
    expect(screen.getByText(/Lake · Maine, United States/)).toBeTruthy();
    // Distance from the user, in whole kilometres this far away.
    expect(screen.getAllByText(/\d km$/).length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: /^Katahdin, Peak/ }));
    });
    expect(onSelect).toHaveBeenCalledWith(KATAHDIN);
  });

  it('aborts a request a newer keystroke made stale', async () => {
    mockFetchPlaces.mockReturnValue(new Promise(() => {}));
    await renderSheet();
    await type('Mont');
    await settle();
    const first = mockFetchPlaces.mock.calls[0]?.[0] as { signal: AbortSignal };
    expect(first.signal.aborted).toBe(false);
    await type('Mont-Sainte-Anne');
    expect(first.signal.aborted).toBe(true);
    expect(screen.getByLabelText('Searching')).toBeTruthy();
  });

  it('answers a coordinate first, without asking the index', async () => {
    const { onSelect } = await renderSheet();
    await type('46.8139, -71.2082');
    await settle();
    expect(mockFetchPlaces).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: /Coordinates/ }));
    });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'coordinates', latitude: 46.8139, longitude: -71.2082 }),
    );
  });

  it('falls back to what is on the device when offline', async () => {
    const { PlaceSearchError } = jest.requireMock<{
      PlaceSearchError: new (r: string) => Error;
    }>('@data/placeSearch');
    mockFetchPlaces.mockRejectedValue(new PlaceSearchError('offline'));
    useLibraryStore.setState({
      waypoints: [
        {
          id: 'w1',
          label: 'Camping Mont-Sainte-Anne',
          latitude: 47.12,
          longitude: -70.87,
          createdAt: 0,
        },
      ],
    });
    const { onSelect } = await renderSheet();
    await type('sainte anne');
    await settle();
    expect(
      screen.getByText(/Search needs a connection\. Showing matches on this device\./),
    ).toBeTruthy();
    expect(screen.getByText('ON THIS DEVICE')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: /^Camping Mont-Sainte-Anne/ }));
    });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'waypoint:w1', type: 'waypoint' }),
    );
  });

  it('never asks the index under "Locally downloaded only"', async () => {
    await act(async () => {
      useSettingsStore.setState({ offlineOnly: true });
    });
    await renderSheet();
    await type('Chamonix');
    await settle();
    expect(mockFetchPlaces).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Locally downloaded only.*Nothing on this device matches\./),
    ).toBeTruthy();
  });

  it('says so when the index finds nothing, or is busy', async () => {
    mockFetchPlaces.mockResolvedValueOnce([]);
    await renderSheet();
    await type('zzqx');
    await settle();
    expect(screen.getByText('No places found for “zzqx”.')).toBeTruthy();

    const { PlaceSearchError } = jest.requireMock<{
      PlaceSearchError: new (r: string) => Error;
    }>('@data/placeSearch');
    mockFetchPlaces.mockRejectedValueOnce(new PlaceSearchError('busy'));
    await type('zzqxy');
    await settle();
    expect(screen.getByText(/Search is busy/)).toBeTruthy();
  });

  it('lists recent picks when empty, and clears them', async () => {
    mockStoredRecents = [KATAHDIN];
    const { onSelect } = await renderSheet();
    expect(screen.getByText('RECENT')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: /^Katahdin, Peak/ }));
    });
    expect(onSelect).toHaveBeenCalledWith(KATAHDIN);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Clear recent searches'));
    });
    expect(usePlaceRecentsStore.getState().recents).toEqual([]);
    expect(mockSave).toHaveBeenLastCalledWith([]);
    expect(screen.queryByText('RECENT')).toBeNull();
  });

  it('closes from its ✕', async () => {
    const { onClose } = await renderSheet();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Close search'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clears the box from its clear button', async () => {
    await renderSheet();
    await type('Chamonix');
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Clear search'));
    });
    expect(screen.getByLabelText('Search places').props.value).toBe('');
  });

  it('picks the first result on the keyboard Search key', async () => {
    mockFetchPlaces.mockResolvedValue([KATAHDIN]);
    const { onSelect } = await renderSheet({ origin: null });
    await type('Katahdin');
    await settle();
    await act(async () => {
      fireEvent(screen.getByLabelText('Search places'), 'submitEditing');
    });
    expect(onSelect).toHaveBeenCalledWith(KATAHDIN);
    // No position: no distance column.
    expect(screen.queryByText(/\d km$/)).toBeNull();
  });
});
