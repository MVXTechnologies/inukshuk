/**
 * What the map's top slot shows (#707): the place search, or — in team mode —
 * the team's own content (today: nothing; the team status bar will drop into
 * this slot). `pending` while that is not known yet: the slot stays EMPTY,
 * so the search bar is never drawn and then pulled away a second later.
 *
 * At launch the answer arrives in steps, each async: the settings file (is
 * the Team extension installed and switched on?), then the team list on
 * disk, then reopening the last team (`TeamHost`), whose replayed log says
 * whether I am still an active member. Until the chain settles one way, the
 * slot waits; any step that rules team mode out answers `search` at once.
 *
 * Pure: the caller (`useSearchSlotMode`) feeds the stores' state and bounds
 * the wait (a reopen that fails must not hide search for ever).
 */

export type SearchSlotMode = 'pending' | 'search' | 'team';

export interface SearchSlotInputs {
  /** The settings file has been read (the extension prefs are real, not defaults). */
  settingsHydrated: boolean;
  /** The Team extension is installed and its switch is on. */
  teamEnabled: boolean;
  /** This binary has team support at all. */
  teamAvailable: boolean;
  /** The team list has been read from disk. */
  teamsLoaded: boolean;
  /** How many teams are on this device (the last one opened is reopened at launch). */
  teamCount: number;
  /** A team is open. */
  sessionOpen: boolean;
  /** …and I am an active member of it. */
  memberActive: boolean;
}

export function searchSlotMode(i: SearchSlotInputs): SearchSlotMode {
  if (!i.settingsHydrated) return 'pending';
  if (!i.teamEnabled || !i.teamAvailable) return 'search';
  if (i.sessionOpen) return i.memberActive ? 'team' : 'search';
  if (!i.teamsLoaded) return 'pending';
  // Loaded, nothing open yet: TeamHost reopens the last team, if there is one.
  return i.teamCount > 0 ? 'pending' : 'search';
}
