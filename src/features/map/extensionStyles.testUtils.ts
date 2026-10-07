import { useSettingsStore } from '@state/settingsStore';

/** Test helper: put the extensions' persisted state in the settings store. */
export function setExtensionsForTest(s: {
  geoInstalled: boolean;
  geoOffline: boolean;
  geoShown: boolean;
  tidesInstalled: boolean;
  tidesShown: boolean;
}): void {
  useSettingsStore.setState({
    geodeticInstalledAt: s.geoInstalled ? 1_759_600_000_000 : 0,
    geodeticOffline: s.geoOffline,
    showGeodetic: s.geoShown,
    tidesInstalledAt: s.tidesInstalled ? 1_759_700_000_000 : 0,
    showTideStations: s.tidesShown,
  });
}
