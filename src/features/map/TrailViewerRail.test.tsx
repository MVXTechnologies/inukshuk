import { render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { TrailViewerRail } from './TrailViewerRail';

/**
 * #480 (owner: "Remove the 3D button from the focused view"): the rail keeps
 * its basemap and overlay menus, and no 2D/3D toggle.
 */
async function mount(): Promise<void> {
  await render(
    <PaperProvider>
      <TrailViewerRail top={0} basemap="map" onSelectBasemap={() => undefined} />
    </PaperProvider>,
  );
}

it('has no 2D/3D toggle', async () => {
  await mount();
  expect(screen.queryByLabelText(/Switch to (2D|3D) view/)).toBeNull();
});

it('keeps the layers and overlays buttons', async () => {
  await mount();
  expect(screen.getByLabelText('Trail layers')).toBeOnTheScreen();
  expect(screen.getByLabelText('Trail overlays')).toBeOnTheScreen();
});
