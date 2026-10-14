import { useLibraryStore } from '@state/libraryStore';
import { useNavigationStore } from '@state/navigationStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { DestinationChip } from './DestinationChip';

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: jest.fn(async () => null) }));

const CAMP = { id: 'w1', label: 'Camp lac', latitude: 46.82, longitude: -71.2, createdAt: 0 };

async function renderChip(onClear = jest.fn()) {
  await render(
    <PaperProvider>
      <DestinationChip onClear={onClear} />
    </PaperProvider>,
  );
  return onClear;
}

describe('DestinationChip (slim since 2.6.0, #673)', () => {
  beforeEach(() => {
    useNavigationStore.setState({ destination: null, following: null });
    useLibraryStore.setState({ waypoints: [CAMP] as never });
  });

  it('is the name and ✕ only: distance and bearing live in the strip and the tape', async () => {
    useNavigationStore.setState({ destination: { latitude: 46.82, longitude: -71.2 } });
    await renderChip();
    expect(screen.getByText('Camp lac')).toBeOnTheScreen();
    expect(screen.queryByText(/km|°/)).toBeNull();
  });

  it('names a dropped pin "Destination"', async () => {
    useNavigationStore.setState({ destination: { latitude: 46.9, longitude: -71.3 } });
    await renderChip();
    expect(screen.getByLabelText('Navigating to Destination')).toBeOnTheScreen();
  });

  it("keeps Maestro's 'Clear destination' on its ✕", async () => {
    useNavigationStore.setState({ destination: { latitude: 46.9, longitude: -71.3 } });
    const onClear = await renderChip();
    await fireEvent.press(screen.getByLabelText('Clear destination'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('draws nothing without a destination', async () => {
    await renderChip();
    expect(screen.queryByLabelText('Clear destination')).toBeNull();
    await act(async () =>
      useNavigationStore.setState({ destination: { latitude: 46.82, longitude: -71.2 } }),
    );
    expect(screen.getByText('Camp lac')).toBeOnTheScreen();
  });

  it('takes the name of the waypoint it was set on (within 2 m), else "Destination"', async () => {
    // ~1.1 m north of the camp: its name.
    useNavigationStore.setState({ destination: { latitude: 46.82001, longitude: -71.2 } });
    await renderChip();
    expect(screen.getByLabelText('Navigating to Camp lac')).toBeOnTheScreen();
    // ~5.6 m north: a dropped pin.
    await act(async () =>
      useNavigationStore.setState({ destination: { latitude: 46.82005, longitude: -71.2 } }),
    );
    expect(screen.getByLabelText('Navigating to Destination')).toBeOnTheScreen();
  });

  it('follows a rename of that waypoint', async () => {
    useNavigationStore.setState({ destination: { latitude: 46.82, longitude: -71.2 } });
    await renderChip();
    await act(async () =>
      useLibraryStore.setState({ waypoints: [{ ...CAMP, label: 'Camp du lac' }] as never }),
    );
    expect(screen.getByText('Camp du lac')).toBeOnTheScreen();
  });

  it('a long name stays on one line, the ✕ still in reach', async () => {
    const long = 'Refuge du sommet nord, versant est, après le deuxième ruisseau';
    useLibraryStore.setState({ waypoints: [{ ...CAMP, label: long }] as never });
    useNavigationStore.setState({ destination: { latitude: 46.82, longitude: -71.2 } });
    await renderChip();
    expect(screen.getByText(long).props.numberOfLines).toBe(1);
    expect(screen.getByLabelText('Clear destination')).toBeOnTheScreen();
  });

  it('carries no numbers in any state: navigating, renamed, cleared', async () => {
    useNavigationStore.setState({ destination: { latitude: 46.9, longitude: -71.3 } });
    await renderChip();
    expect(screen.queryByText(/\d/)).toBeNull();
    await act(async () => useNavigationStore.setState({ destination: null }));
    expect(screen.queryByLabelText(/Navigating to/)).toBeNull();
  });
});
