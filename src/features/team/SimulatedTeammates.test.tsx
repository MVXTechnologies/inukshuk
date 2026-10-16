/**
 * The loopback build's simulated phones act where this phone is NOW (E2E run
 * 38965284523): the persisted last position is written at most once a
 * minute, so right after a Maestro `setLocation` it still named the previous
 * flow's place and the teammate's note landed ~50 km off screen.
 */
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Location from 'expo-location';
import { PaperProvider } from 'react-native-paper';

import { SimulatedTeammates } from './SimulatedTeammates';

const mockNote = jest.fn((_at: { latitude: number; longitude: number }) => true);
const mockAlert = jest.fn((_k: string, _at: { latitude: number; longitude: number }) => true);
jest.mock('@data/team/simulatedTeammates', () => ({
  addBadgeThreads: jest.fn(async () => true),
  addSimulatedNote: (at: { latitude: number; longitude: number }) => mockNote(at),
  addSimulatedTeammate: jest.fn(async () => true),
  BADGE_THREADS: [],
  simulatedAlert: (k: string, at: { latitude: number; longitude: number }) => mockAlert(k, at),
  SIM_NOTE_TEXT: 'Hut water is dry',
  simulatedTeamToJoin: jest.fn(async () => null),
}));
jest.mock('expo-location', () => ({ getLastKnownPositionAsync: jest.fn() }));
jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: async () => null }));

const lastKnown = Location.getLastKnownPositionAsync as jest.Mock;
const STALE = { latitude: 47.4423, longitude: -70.5012 };
const HERE = { latitude: 47.0745, longitude: -70.9065 };

beforeEach(() => {
  mockNote.mockClear();
  mockAlert.mockClear();
  useSettingsStore.setState({ lastKnownPosition: STALE });
});

const press = async (id: string) => {
  await render(
    <PaperProvider>
      <SimulatedTeammates />
    </PaperProvider>,
  );
  await fireEvent.press(screen.getByTestId(id));
  await act(async () => undefined);
};

it("posts the teammate's note at this phone's fix, not the stale persisted position", async () => {
  lastKnown.mockResolvedValue({ coords: HERE });
  await press('team-sim-note');
  expect(mockNote).toHaveBeenCalledWith(HERE);
});

it('raises the simulated SOS there too', async () => {
  lastKnown.mockResolvedValue({ coords: HERE });
  await press('team-sim-sos');
  expect(mockAlert).toHaveBeenCalledWith('sos', HERE);
});

it('falls back to the persisted position without a fix', async () => {
  lastKnown.mockResolvedValue(null);
  await press('team-sim-note');
  expect(mockNote).toHaveBeenCalledWith(STALE);
});
