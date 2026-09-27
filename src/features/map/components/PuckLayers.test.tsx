import { render } from '@testing-library/react-native';
import { DisplayConditionContext } from '@ui/displayCondition';
import { lightScheme, nightScheme } from '@ui/tokens';
import type { ReactNode } from 'react';
import { PaperProvider } from 'react-native-paper';
import { PuckLayers } from './PuckLayers';

const mockLayers: { id: string; paint: Record<string, unknown> }[] = [];
let mockPosition: { coords: { accuracy: number } } | undefined;

jest.mock('@maplibre/maplibre-react-native', () => ({
  Layer: (props: { id: string; paint: Record<string, unknown> }) => {
    mockLayers.push(props);
    return null;
  },
  useCurrentPosition: () => mockPosition,
}));

async function draw(condition: 'normal' | 'night', weakAccuracyM: number | null = null) {
  mockLayers.length = 0;
  const wrap = ({ children }: { children: ReactNode }) => (
    <PaperProvider>
      <DisplayConditionContext.Provider value={condition}>
        {children}
      </DisplayConditionContext.Provider>
    </PaperProvider>
  );
  await render(<PuckLayers weakAccuracyM={weakAccuracyM} />, { wrapper: wrap });
  return Object.fromEntries(mockLayers.map((l) => [l.id, l.paint]));
}

beforeEach(() => {
  mockPosition = { coords: { accuracy: 12 } };
});

it('draws halo, ring and dot in the scheme puck tokens', async () => {
  const paint = await draw('normal');
  expect(paint['inukshuk-puck-halo']?.['circle-color']).toBe(lightScheme.map.puckHalo);
  expect(paint['inukshuk-puck-ring']?.['circle-color']).toBe(lightScheme.map.puckRing);
  expect(paint['inukshuk-puck-dot']?.['circle-color']).toBe(lightScheme.map.puck);
});

it('turns red on black in Night (no blue puck)', async () => {
  const paint = await draw('night');
  expect(paint['inukshuk-puck-halo']?.['circle-color']).toBe(nightScheme.map.puckHalo);
  expect(paint['inukshuk-puck-dot']?.['circle-color']).toBe(nightScheme.map.puck);
  expect(paint['inukshuk-puck-ring']?.['circle-color']).toBe(nightScheme.map.puckRing);
});

it('skips the halo until the accuracy is known, and adds the weak-signal ring', async () => {
  mockPosition = undefined;
  const paint = await draw('normal', 40);
  expect(paint['inukshuk-puck-halo']).toBeUndefined();
  expect(paint['inukshuk-puck-uncertainty']?.['circle-color']).toBe(lightScheme.status.gpsWeak);
});
