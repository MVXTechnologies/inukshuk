import { METRIC } from '@core/format';
/**
 * Full-screen photo viewers open in their own window, under the status bar:
 * with the strip docked on top, their close button must sit on the REAL
 * status bar inset, not on the strip-shifted one the map's chrome uses
 * (#673 review).
 */
import { stripHeightDp } from '@core/infoStrip/layout';
import type { Area } from '@core/models';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AreaCard } from '../draw/AreaCard';
import { WaypointViewerCard } from '../components/WaypointViewerCard';
import { InfoStripInsets } from './InfoStripInsets';
import { setStripRuntime } from './stripRuntime';
import { METRICS, Providers, resetStores } from './testUtils';

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: jest.fn(async () => null) }));

const STATUS_BAR = METRICS.insets.top;
/** A one-row strip on top, measured with the status bar it reaches behind. */
const STRIP_H = STATUS_BAR + stripHeightDp(1);

function TopProbe() {
  return <Text testID="top-probe">{useSafeAreaInsets().top}</Text>;
}

async function underTopStrip(children: ReactNode) {
  await render(
    <Providers>
      <InfoStripInsets>
        {children}
        <TopProbe />
      </InfoStripInsets>
    </Providers>,
  );
  await act(async () => setStripRuntime({ dock: 'top', stripH: STRIP_H }));
  // The map's chrome moves under the strip...
  expect(screen.getByTestId('top-probe')).toHaveTextContent(String(STRIP_H));
}

const barTop = () =>
  StyleSheet.flatten(screen.getByTestId('photo-viewer-bar').props.style).top as number;

beforeEach(() => {
  resetStores();
  jest.spyOn(Animated, 'timing').mockReturnValue({
    start: jest.fn(),
    stop: jest.fn(),
    reset: jest.fn(),
  } as unknown as Animated.CompositeAnimation);
});
afterEach(() => jest.restoreAllMocks());

describe('photo viewers keep the real status bar inset under a top strip', () => {
  it('a waypoint photo', async () => {
    await underTopStrip(
      <WaypointViewerCard
        waypoint={{ label: 'W', latitude: 46.8, longitude: -71.2, photoUri: 'file:///p.jpg' }}
        onCopyCoords={jest.fn()}
        onCopyNote={jest.fn()}
        onSharePhoto={jest.fn()}
        onEdit={jest.fn()}
        onDelete={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    await fireEvent.press(screen.getByLabelText('View photo'));
    // ...the viewer's close button does not.
    expect(barTop()).toBe(STATUS_BAR + 8);
  });

  it('an area photo', async () => {
    const area: Area = {
      id: 'a1',
      name: 'Slope',
      ring: [
        [-71.2, 46.8],
        [-71.19, 46.8],
        [-71.19, 46.81],
      ],
      color: '#2563EB',
      photoUris: ['file:///doc/photos/a.jpg'],
      createdAt: 1,
    };
    await underTopStrip(
      <AreaCard
        area={area}
        units={METRIC}
        onEdit={jest.fn()}
        onDelete={jest.fn()}
        onClose={jest.fn()}
        onAddPhoto={jest.fn()}
        onShare={jest.fn()}
      />,
    );
    await fireEvent.press(screen.getByLabelText('View photo'));
    expect(barTop()).toBe(STATUS_BAR + 8);
  });
});
