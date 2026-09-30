import { render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { useSettingsStore } from '@state/settingsStore';
import { TrailViewerRail } from './TrailViewerRail';

/**
 * #480 (owner: "Remove the 3D button from the focused view"): the rail keeps
 * its basemap and overlay menus, and no 2D/3D toggle in either persisted mode.
 */
async function mount(overlaysAvailable = true): Promise<void> {
  await render(
    <PaperProvider>
      <TrailViewerRail
        top={0}
        basemap="map"
        onSelectBasemap={() => undefined}
        overlaysAvailable={overlaysAvailable}
      />
    </PaperProvider>,
  );
}

it.each(['2d', '3d'] as const)('has no 2D/3D toggle (persisted mode %s)', async (mode) => {
  useSettingsStore.setState({ trailViewMode: mode });
  await mount();
  expect(screen.queryByLabelText(/Switch to (2D|3D) view/)).toBeNull();
});

it('keeps the layers and overlays buttons', async () => {
  await mount();
  expect(screen.getByLabelText('Trail layers')).toBeOnTheScreen();
  expect(screen.getByLabelText('Trail overlays')).toBeOnTheScreen();
});
