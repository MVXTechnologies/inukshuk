import { useSettingsStore } from '@state/settingsStore';
import { render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { ScaleBar } from './ScaleBar';

/**
 * The bar's numbers come from `@core/geo/scaleBar` (tested there); what this
 * covers is the wiring the pure module cannot see — that the bar follows the
 * user's unit SETTING, that it re-labels when that setting flips, and that an
 * unrenderable camera draws nothing instead of a zero-width stub.
 */
async function renderAt(zoom: number, latitude: number): Promise<void> {
  await render(
    <PaperProvider>
      <ScaleBar zoom={zoom} latitude={latitude} />
    </PaperProvider>,
  );
}

describe('ScaleBar', () => {
  // BEFORE each, not after: a post-test store write lands on a component the
  // testing library has not unmounted yet, and React (rightly) complains about
  // an update outside act().
  beforeEach(() => {
    useSettingsStore.setState({ units: 'metric' });
  });

  it('labels a round metric distance', async () => {
    await renderAt(13, 46.8);
    expect(screen.getByLabelText('Scale 500 m')).toBeOnTheScreen();
  });

  it('follows the units setting', async () => {
    useSettingsStore.setState({ units: 'imperial' });
    await renderAt(13, 46.8);
    expect(screen.getByLabelText('Scale 2000 ft')).toBeOnTheScreen();
  });

  // Same zoom, two latitudes: a Mercator pixel covers far less ground in the
  // north, so the same 104 dp of bar has to describe a shorter distance.
  it('reads 2 km at the equator at zoom 11', async () => {
    await renderAt(11, 0);
    expect(screen.getByLabelText('Scale 2 km')).toBeOnTheScreen();
  });

  it('reads only 1 km at 75°N at the very same zoom', async () => {
    await renderAt(11, 75);
    expect(screen.getByLabelText('Scale 1 km')).toBeOnTheScreen();
  });

  it('renders nothing when the camera state cannot produce a bar', async () => {
    await renderAt(Number.NaN, 46.8);
    expect(screen.queryByLabelText(/^Scale /)).toBeNull();
  });
});
