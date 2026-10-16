/**
 * An SOS notification from a team not on screen (`?team=`) shows that team
 * first, then centres the map on the SOS (owner decision 2026-10-16).
 */
import { useTeamStore } from '@state/teamStore';
import { act, render } from '@testing-library/react-native';

import { TeamAlertRoute } from './TeamAlertRoute';
import { useTeamMapFocus } from './teamMapFocus';

const mockReplace = jest.fn();
let mockParams: Record<string, string> = {};
const mockSwitch = jest.fn();

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: async () => null }));
jest.mock('@data/team/appTeam', () => ({
  teamAvailability: () => 'ok',
  appTeamService: () => null,
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@state/teamStore', () => ({
  ...jest.requireActual('@state/teamStore'),
  switchToTeam: (id: string) => mockSwitch(id),
}));

const sos = { id: 's1', owner: 'lea', lat: 48.9, lng: -66.1, text: '', at: 1, resolved: false };

beforeEach(() => {
  mockReplace.mockClear();
  mockSwitch.mockReset();
  useTeamStore.setState({ soses: [], positions: [], rally: null });
  jest.spyOn(useTeamMapFocus.getState(), 'focus');
});

it('switches to the alert’s team, then centres on its SOS and leaves', async () => {
  mockParams = { owner: 'lea', id: 's1', team: 'hut' };
  let finish: () => void = () => undefined;
  mockSwitch.mockReturnValue(new Promise<boolean>((r) => (finish = () => r(true))));
  await render(<TeamAlertRoute kind="sos" />);
  expect(mockSwitch).toHaveBeenCalledWith('hut');
  // Not before the team is on screen (its SOS isn't in the store yet).
  expect(mockReplace).not.toHaveBeenCalled();
  await act(async () => {
    useTeamStore.setState({ soses: [sos as never] });
    finish();
  });
  expect(useTeamMapFocus.getState().focus).toHaveBeenCalledWith(-66.1, 48.9, 16);
  expect(mockReplace).toHaveBeenCalledWith('/');
});

it('a link without a team goes straight to the map', async () => {
  mockParams = { owner: 'lea', id: 's1' };
  useTeamStore.setState({ soses: [sos as never] });
  await render(<TeamAlertRoute kind="sos" />);
  expect(mockSwitch).not.toHaveBeenCalled();
  expect(mockReplace).toHaveBeenCalledWith('/');
});
