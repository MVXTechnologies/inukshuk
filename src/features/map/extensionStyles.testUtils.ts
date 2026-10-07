import { defaultExtensionPrefs } from '@core/extensions/prefs';
import { useSettingsStore } from '@state/settingsStore';

/** Test helper: put the extensions' persisted state in the settings store. */
export function setExtensionsForTest(s: {
  geoInstalled: boolean;
  geoOffline: boolean;
  geoShown: boolean;
  tidesInstalled: boolean;
  tidesShown: boolean;
}): void {
  const d = defaultExtensionPrefs();
  useSettingsStore.setState({
    extensions: {
      ...d,
      geodetic: {
        installedAt: s.geoInstalled ? 1_759_600_000_000 : 0,
        show: s.geoShown,
        offline: s.geoOffline,
      },
      tides: {
        ...d.tides,
        installedAt: s.tidesInstalled ? 1_759_700_000_000 : 0,
        show: s.tidesShown,
      },
    },
  });
}
