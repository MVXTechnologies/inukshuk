import { searchSlotMode, type SearchSlotInputs } from './searchSlot';

const TEAM_LAUNCH: SearchSlotInputs = {
  settingsHydrated: true,
  teamEnabled: true,
  teamAvailable: true,
  teamsLoaded: true,
  teamCount: 1,
  sessionOpen: true,
  memberActive: true,
};

describe('searchSlotMode (#707)', () => {
  it('waits for the settings file: the extension prefs are only defaults before it', () => {
    expect(searchSlotMode({ ...TEAM_LAUNCH, settingsHydrated: false })).toBe('pending');
    expect(searchSlotMode({ ...TEAM_LAUNCH, settingsHydrated: false, teamEnabled: false })).toBe(
      'pending',
    );
  });

  it('is search at once when team mode is ruled out', () => {
    const base = { ...TEAM_LAUNCH, teamsLoaded: false, sessionOpen: false, memberActive: false };
    expect(searchSlotMode({ ...base, teamEnabled: false })).toBe('search');
    expect(searchSlotMode({ ...base, teamAvailable: false })).toBe('search');
  });

  it('waits through the launch chain while a team will be reopened', () => {
    const chain: SearchSlotInputs[] = [
      { ...TEAM_LAUNCH, teamsLoaded: false, teamCount: 0, sessionOpen: false, memberActive: false },
      { ...TEAM_LAUNCH, sessionOpen: false, memberActive: false },
      TEAM_LAUNCH,
    ];
    expect(chain.map(searchSlotMode)).toEqual(['pending', 'pending', 'team']);
  });

  it('is search once loaded with no team on the device, or removed from the open one', () => {
    expect(
      searchSlotMode({ ...TEAM_LAUNCH, teamCount: 0, sessionOpen: false, memberActive: false }),
    ).toBe('search');
    expect(searchSlotMode({ ...TEAM_LAUNCH, memberActive: false })).toBe('search');
  });
});
