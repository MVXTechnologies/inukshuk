import { IMPERIAL, METRIC } from '@core/format';
import type { FollowReadout } from '@core/nav';
import { lightTheme } from '@ui/theme';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { NavigationCompassRow } from './NavigationCompassRow';
import type { FollowState } from './useFollowTrail';

type Listener = (s: { headingDeg: number; accuracy: number | null }) => void;
const mockListeners = new Set<Listener>();
jest.mock('../useCompass', () => ({
  subscribeHeading: (l: Listener) => {
    mockListeners.add(l);
    return () => mockListeners.delete(l);
  },
}));
jest.useFakeTimers();

const QC = { latitude: 46.8139, longitude: -71.2082 };

function readout(over: Partial<FollowReadout> = {}): FollowReadout {
  return {
    alongM: 100,
    crossTrackM: 4,
    onTrail: true,
    nearest: QC,
    trailBearingDeg: 4,
    target: { kind: 'waypoint', id: 'w', name: 'Camp lac', at: QC, alongM: 1500 },
    targetBearingDeg: 22,
    targetDistanceM: 1404,
    cost: { segments: 0, cells: 0, windowSegments: 0, global: false },
    ...over,
  };
}

async function mount(props: Partial<Parameters<typeof NavigationCompassRow>[0]>) {
  await render(
    <PaperProvider theme={lightTheme}>
      <NavigationCompassRow
        location={QC}
        destination={null}
        follow={null}
        units={METRIC}
        {...props}
      />
    </PaperProvider>,
  );
  await act(async () => {
    for (const l of mockListeners) l({ headingDeg: 8, accuracy: 3 });
  });
  const slab = screen.queryByTestId('nav-compass');
  if (slab) {
    await fireEvent(slab, 'layout', { nativeEvent: { layout: { width: 358, height: 44 } } });
  }
}

beforeEach(() => mockListeners.clear());

describe('NavigationCompassRow', () => {
  it('is nothing without a navigation', async () => {
    await mount({});
    expect(screen.queryByTestId('nav-compass')).toBeNull();
  });

  it('navigating to a point: distance and bearing on the left', async () => {
    await mount({
      destination: { distanceM: 1230, bearingDeg: 42, distance: '1.23 km', bearing: '042° NE' },
    });
    expect(screen.getByText('1.23 km')).toBeTruthy();
    expect(screen.getByText('042° NE')).toBeTruthy();
    expect(screen.getByText('Right 34°')).toBeTruthy();
  });

  it('following a trail: the target, its distance, and On trail', async () => {
    const follow: FollowState = { name: 'Sentier des Crêtes', readout: readout() };
    await mount({ follow });
    expect(screen.getByText('1.40 km')).toBeTruthy();
    expect(screen.getByText('› Camp lac')).toBeTruthy();
    expect(screen.getByText('On trail')).toBeTruthy();
    expect(screen.getByTestId('nav-compass-trail-bar')).toBeTruthy();
  });

  it('off the trail: the distance to it, in the user’s units', async () => {
    await mount({
      follow: { name: 'T', readout: readout({ onTrail: false, crossTrackM: 62 }) },
      units: IMPERIAL,
    });
    // Short enough to fit whole ("Off trail 1…" was cut, 2.5.1 QA)…
    expect(screen.getByText('Off 203 ft')).toBeTruthy();
    // …and said in full to screen readers.
    expect(screen.getByTestId('nav-compass').props.accessibilityLabel).toContain(
      'Off trail, 203 ft',
    );
  });

  it('following wins over a stale destination, and waits for its readout', async () => {
    await mount({
      follow: { name: 'T', readout: null },
      destination: { distanceM: 10, bearingDeg: 0, distance: '10 m', bearing: '000° N' },
    });
    expect(screen.queryByTestId('nav-compass')).toBeNull();
  });
});
