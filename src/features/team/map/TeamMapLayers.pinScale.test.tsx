/**
 * Settings › Display › Pin size (#686) on the team map: a shared waypoint is
 * a pin and follows the setting; a teammate's dot is a person and does not.
 */
import { useSettingsStore } from '@state/settingsStore';
import { act, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { PaperProvider } from 'react-native-paper';

import { TeamMapLayers } from './TeamMapLayers';

type Props = Record<string, unknown> & { children?: ReactNode };
const mockLayers: Props[] = [];

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));
jest.mock('@maplibre/maplibre-react-native', () => ({
  GeoJSONSource: (props: Props) => props.children ?? null,
  Layer: (props: Props) => {
    mockLayers.push(props);
    return null;
  },
}));
jest.mock('@features/extensions/prefs', () => ({
  useExtensionPrefs: () => ({ installedAt: 1, show: true }),
}));
jest.mock('@state/teamStore', () => {
  const state = {
    view: { me: 'me', members: [] },
    positions: [
      {
        memberId: 'ana',
        name: 'Ana',
        initials: 'A',
        color: '#7E57C2',
        lat: 46.8,
        lng: -71.2,
        at: 0,
        ageMin: 1,
        band: 'fresh',
        ring: 'member',
      },
    ],
    statuses: new Map(),
    shares: {
      waypoints: [{ id: 'w1', name: 'Shared', lat: 46.81, lon: -71.2, color: null }],
      tracks: [],
    },
    teamTrails: [],
  };
  return { useTeamStore: (pick: (s: typeof state) => unknown) => pick(state) };
});

const paintOf = (id: string) =>
  ([...mockLayers].reverse().find((l) => l.id === id)?.paint ?? {}) as Record<string, unknown>;
const layoutOf = (id: string) =>
  ([...mockLayers].reverse().find((l) => l.id === id)?.layout ?? {}) as Record<string, unknown>;

beforeEach(() => {
  mockLayers.length = 0;
  useSettingsStore.setState({ pinScale: 100 });
});

it('scales the shared waypoint dot and its label gap, never the teammates', async () => {
  await render(
    <PaperProvider>
      <TeamMapLayers glyphs="https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf" />
    </PaperProvider>,
  );
  expect(paintOf('team-waypoint-dot')['circle-radius']).toBe(6);
  expect(layoutOf('team-waypoint-label')['text-offset']).toEqual([0.9, 0]);
  const member = paintOf('team-member-dot')['circle-radius'];

  await act(async () => useSettingsStore.setState({ pinScale: 150 }));

  expect(paintOf('team-waypoint-dot')['circle-radius']).toBe(9);
  expect(paintOf('team-waypoint-dot')['circle-stroke-width']).toBe(4.5);
  expect(layoutOf('team-waypoint-label')['text-offset']).toEqual([1.35, 0]);
  expect(paintOf('team-member-dot')['circle-radius']).toBe(member);
});
