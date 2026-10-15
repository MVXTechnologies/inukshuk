/**
 * The map's top slot at launch (#707): with team mode persisted ON, the
 * search bar is never drawn and then pulled away; without it, search shows
 * as soon as the settings are read. Replays the launch's async steps in
 * order and records every value the slot renders.
 */
import { defaultExtensionPrefs } from '@core/extensions/prefs';
import type { SearchSlotMode } from '@core/teamui/searchSlot';
import { useSettingsStore } from '@state/settingsStore';
import { useTeamStore } from '@state/teamStore';
import { act, render } from '@testing-library/react-native';
import { SEARCH_SLOT_MAX_WAIT_MS, useSearchSlotMode } from './teamMode';

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: async () => null }));
jest.mock('@data/team/appTeam', () => ({
  teamAvailability: () => 'ok',
  appTeamService: () => null,
}));

const seen: SearchSlotMode[] = [];
function Probe() {
  const mode = useSearchSlotMode();
  if (seen[seen.length - 1] !== mode) seen.push(mode);
  return null;
}

/** The store state before anything is read from disk. */
function coldStart(): void {
  useSettingsStore.setState({ hydrated: false, extensions: defaultExtensionPrefs() });
  useTeamStore.setState({ available: true, loaded: false, teams: [], view: null });
}

/** The settings file arrives, with the Team extension on (or not). */
function settingsRead(teamOn: boolean): void {
  const d = defaultExtensionPrefs();
  useSettingsStore.setState({
    hydrated: true,
    extensions: { ...d, team: { ...d.team, installedAt: teamOn ? 1 : 0, show: teamOn } },
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  seen.length = 0;
  coldStart();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useSearchSlotMode (#707)', () => {
  it('team mode on: empty slot through the launch, then team; search never shows', async () => {
    await render(<Probe />);
    await act(async () => settingsRead(true));
    // The team list read: one team, which TeamHost reopens next.
    await act(async () => useTeamStore.setState({ loaded: true, teams: [{} as never] }));
    await act(async () => {
      jest.advanceTimersByTime(900); // replaying the team's log
    });
    await act(async () => useTeamStore.setState({ view: { active: true } as never }));
    expect(seen).toEqual(['pending', 'team']);
  });

  it('team mode off: search as soon as the settings are read', async () => {
    await render(<Probe />);
    await act(async () => settingsRead(false));
    expect(seen).toEqual(['pending', 'search']);
  });

  it('extension on with no team on the device: search once the list is read', async () => {
    await render(<Probe />);
    await act(async () => settingsRead(true));
    await act(async () => useTeamStore.setState({ loaded: true, teams: [] }));
    expect(seen).toEqual(['pending', 'search']);
  });

  it('a reopen that never finishes gives search back after the wait ceiling', async () => {
    await render(<Probe />);
    await act(async () => settingsRead(true));
    await act(async () => useTeamStore.setState({ loaded: true, teams: [{} as never] }));
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_SLOT_MAX_WAIT_MS - 1);
    });
    expect(seen).toEqual(['pending']);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(seen).toEqual(['pending', 'search']);
  });
});
