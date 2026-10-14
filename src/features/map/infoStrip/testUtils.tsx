/**
 * Test-only helpers for the info strip's component tests: the stores reset
 * to a known strip, a provider tree in either theme, and a stand-in for
 * MapScreen that counts its own renders.
 */
import { METRIC } from '@core/format';
import { applyPreset, presetById, type PresetId } from '@core/infoStrip/presets';
import { normaliseInfoStripSettings } from '@core/infoStrip/settings';
import type { InfoStrip } from '@core/infoStrip/types';
import { useMapStore } from '@state/mapStore';
import { useNavigationStore } from '@state/navigationStore';
import { useSettingsStore } from '@state/settingsStore';
import { darkTheme, lightTheme } from '@ui/theme';
import type { ReactNode } from 'react';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { resetStripRuntime } from './stripRuntime';

export const QC = { latitude: 46.81394, longitude: -71.20761 };

export const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 40, left: 0, right: 0, bottom: 24 },
};

/** Fresh stores: the default strip, decimal degrees, metric, the map settled on Québec City. */
export function resetStores(): void {
  resetStripRuntime();
  useSettingsStore.setState({
    infoStrip: normaliseInfoStripSettings(undefined),
    coordinateFormat: 'dd',
    units: METRIC,
    hydrated: true,
  });
  useMapStore.setState({ mapCenter: QC, followUser: false });
  useNavigationStore.setState({ destination: null, following: null });
}

/** Put a preset (or any strip) on the map. */
export function putStrip(s: PresetId | InfoStrip): void {
  const strip = typeof s === 'string' ? applyPreset(presetById(s)!, new Set()) : s;
  const all = useSettingsStore.getState().infoStrip;
  useSettingsStore.setState({ infoStrip: { ...all, current: strip } });
}

export function Providers({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <PaperProvider theme={dark ? darkTheme : lightTheme}>{children}</PaperProvider>
    </SafeAreaProvider>
  );
}

export const currentStrip = () => useSettingsStore.getState().infoStrip.current;
