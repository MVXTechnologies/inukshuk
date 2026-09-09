import { render, screen } from '@testing-library/react-native';
import { useSettingsStore } from '@state/settingsStore';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { PaperProvider } from 'react-native-paper';
import { TrailViewerRail } from './TrailViewerRail';

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: async () => null }));

it('keeps basemaps available without exposing parked 3D controls, even with a saved 3D preference', async () => {
  useSettingsStore.setState({ trailViewMode: '3d' });
  await render(
    <SafeAreaInsetsContext.Provider value={{ top: 0, right: 0, bottom: 0, left: 0 }}>
      <PaperProvider>
        <TrailViewerRail top={100} basemap="map" onSelectBasemap={jest.fn()} overlaysAvailable />
      </PaperProvider>
    </SafeAreaInsetsContext.Provider>,
  );
  expect(screen.getByLabelText('Trail layers')).toBeTruthy();
  expect(screen.queryByLabelText(/Switch to .* view/)).toBeNull();
  expect(screen.queryByLabelText('Trail overlays')).toBeNull();
});
