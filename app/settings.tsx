import { SettingsScreen } from '@features/settings/SettingsScreen';

/**
 * Settings is a stack screen, not a tab (revamp decision 6): it is reached
 * from the gear in the Library and Logbook headers and from the map's "+"
 * sheet, and returns with the header's back button.
 */
export default function SettingsRoute() {
  return <SettingsScreen />;
}
