import { fireEvent, render, screen } from '@testing-library/react-native';
import { OverlaysDrilldown } from './MapOverlaysMenu';

/**
 * The parked state of the Weather and Marine rows is SHIPPED BEHAVIOUR, so it
 * gets a test like anything else — and the same suite, run with the flags
 * flipped, is the executable proof of the parking's central promise: turning
 * `WEATHER_ENABLED` / `MARINE_ENABLED` back on is all it takes to get the
 * features back.
 *
 * The flags are mocked through getters rather than static values so one module
 * registry can serve both halves; the component reads them at render time, so
 * flipping between tests is enough.
 */
const mockFlags = { WEATHER_ENABLED: false, MARINE_ENABLED: false };
jest.mock('@core/features/flags', () => ({
  get WEATHER_ENABLED() {
    return mockFlags.WEATHER_ENABLED;
  },
  get MARINE_ENABLED() {
    return mockFlags.MARINE_ENABLED;
  },
  PARKED_LABEL: 'Coming soon',
}));

const noop = (): void => undefined;

// `render` resolves asynchronously here (React 19 act); awaiting it is what
// populates `screen`, exactly as mapLayers.test.tsx does.
async function renderMenu(): Promise<void> {
  await render(
    <OverlaysDrilldown
      showHypso={false}
      onSlopeEnabled={noop}
      onOpenFolders={noop}
      onOpenTrailNetworks={noop}
    />,
  );
}

describe('OverlaysDrilldown', () => {
  afterEach(() => {
    mockFlags.WEATHER_ENABLED = false;
    mockFlags.MARINE_ENABLED = false;
  });

  describe('with weather and marine parked', () => {
    it('keeps both rows visible, greyed and labelled "Coming soon"', async () => {
      await renderMenu();

      // Visible, not removed — the row is the only place the user is told
      // this is deliberate rather than broken.
      const weather = screen.getByLabelText('Weather (coming soon)');
      const marine = screen.getByLabelText('Marine (coming soon)');
      expect(weather.props.accessibilityState).toMatchObject({ disabled: true });
      // The marine row must not advertise a chart mode the map is not drawing.
      expect(marine.props.accessibilityState).toMatchObject({ disabled: true, checked: false });
      expect(screen.getByText('Weather')).toBeTruthy();
      expect(screen.getByText('Marine')).toBeTruthy();
      expect(screen.getAllByText('Coming soon')).toHaveLength(2);

      // ...and Topology is untouched (the Maestro flows key on this label).
      expect(screen.getByLabelText('Topology')).toBeTruthy();
    });

    it('does not drill into the weather sub-menu when the row is pressed', async () => {
      await renderMenu();
      fireEvent.press(screen.getByLabelText('Weather (coming soon)'));
      // Still at the top level: the row is unchanged and no sub-menu opened.
      expect(await screen.findByLabelText('Weather (coming soon)')).toBeTruthy();
      expect(screen.queryByLabelText('Back to overlays')).toBeNull();
      expect(screen.getByLabelText('Topology')).toBeTruthy();
    });
  });

  describe('with the flags flipped back on', () => {
    it('restores the live Weather and Marine rows', async () => {
      mockFlags.WEATHER_ENABLED = true;
      mockFlags.MARINE_ENABLED = true;
      await renderMenu();

      expect(screen.getByLabelText('Weather')).toBeTruthy();
      expect(screen.getByLabelText('Marine')).toBeTruthy();
      expect(screen.queryByText('Coming soon')).toBeNull();
    });

    it('drills into the weather sub-menu again', async () => {
      mockFlags.WEATHER_ENABLED = true;
      await renderMenu();
      fireEvent.press(screen.getByLabelText('Weather'));
      expect(await screen.findByLabelText('Back to overlays')).toBeTruthy();
    });
  });
});
