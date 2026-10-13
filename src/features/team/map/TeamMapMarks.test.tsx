import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { useTeamMapMarks } from './TeamMapMarks';

type Props = Record<string, unknown> & { children?: ReactNode };
const mockLayers: Props[] = [];
const mockSources: Props[] = [];

jest.mock('@maplibre/maplibre-react-native', () => {
  const { forwardRef } = jest.requireActual<typeof import('react')>('react');
  return {
    GeoJSONSource: forwardRef((props: Props, _ref) => {
      mockSources.push(props);
      return props.children ?? null;
    }),
    Layer: (props: Props) => {
      mockLayers.push(props);
      return null;
    },
  };
});

// Two photos with comments: a two- and a three-character badge.
jest.mock('@core/teamui/mapMarks', () => ({
  teamMapMarks: () => ({
    bubbles: [
      { key: 'a', photo: { lng: -71.2, lat: 46.81 }, count: 12, fresh: true },
      { key: 'b', photo: { lng: -71.19, lat: 46.81 }, count: 120, fresh: false },
    ],
    pins: [],
    tasks: [],
  }),
}));
jest.mock('@state/teamStore', () => {
  const state = {
    view: { me: 'me', members: [] },
    photos: [],
    photoThreads: new Map(),
    pins: [],
    resolved: new Set(),
    tasks: [],
    record: { seen: {} },
  };
  return { useTeamStore: (pick: (s: typeof state) => unknown) => pick(state) };
});
jest.mock('@features/extensions/prefs', () => ({
  useExtensionPrefs: () => ({ installedAt: 1, show: true }),
}));
jest.mock('../useAnchorLookup', () => ({ useAnchorLookup: () => ({}) }));
jest.mock('./TeamMapLayers', () => ({ teamLabelFont: () => ['Noto Sans Bold'] }));
jest.mock('@ui/useSchemeTokens', () => ({
  useSchemeTokens: () => ({
    inkMuted: '#888',
    team: {
      bubbleNew: '#e07a2f',
      bubbleNewInk: '#fff',
      mapPaper: '#fff',
      mapInk: '#222',
      mapHalo: '#fff',
      onAvatar: '#fff',
    },
  }),
}));

function Host() {
  return <>{useTeamMapMarks('https://tiles.example/fonts/{fontstack}/{range}.pbf', 15)}</>;
}

beforeEach(() => {
  mockLayers.length = 0;
  mockSources.length = 0;
});

it("draws each photo's comment badge: a circle and its number from the feature's label", async () => {
  await render(<Host />);
  const source = mockSources.find((s) => s.id === 'team-marks');
  const features = (source?.data as GeoJSON.FeatureCollection).features;
  // Two and three characters at most: "12", and "99+" past 99.
  expect(features.map((f) => f.properties?.['label'])).toEqual(['12', '99+']);
  expect(features.every((f) => f.properties?.['kind'] === 'bubble')).toBe(true);

  const circle = mockLayers.find((l) => l.id === 'team-mark-bubble');
  const number = mockLayers.find((l) => l.id === 'team-mark-bubble-count');
  expect(circle?.type).toBe('circle');
  expect(number?.type).toBe('symbol');
  // Both filter on the same kind, and the number reads the label property.
  expect(number?.filter).toEqual(circle?.filter);
  const layout = number?.layout as Record<string, unknown>;
  expect(layout['text-field']).toEqual(['get', 'label']);
  expect(layout['text-font']).toEqual(['Noto Sans Bold']);
  // The number sits on its circle: the same pixel offset.
  const paint = number?.paint as Record<string, unknown>;
  expect(paint['text-translate']).toEqual(
    (circle?.paint as Record<string, unknown>)['circle-translate'],
  );
});
