/**
 * #747 — in team mode a tapped trail opens its spot card; that trail wears
 * the selection highlight (glow + bright casing, wider line) while the card
 * is up, and goes back to normal when it closes.
 */
import { selectionHighlight } from '@core/map/selectionHighlight';
import { act, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { PaperProvider } from 'react-native-paper';

import { useTeamTrailLayers } from './TeamFieldLayers';
import { useTeamSheet } from './teamMode';

type Props = Record<string, unknown> & { children?: ReactNode; data?: unknown };
const mockLayers: Props[] = [];
const mockSources: Props[] = [];

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));
jest.mock('@maplibre/maplibre-react-native', () => ({
  GeoJSONSource: (props: Props) => {
    mockSources.push(props);
    return props.children ?? null;
  },
  Layer: (props: Props) => {
    mockLayers.push(props);
    return null;
  },
}));
jest.mock('@state/teamStore', () => {
  const state = {
    view: { me: 'me', members: [{ id: 'ana', name: 'Ana', color: '#7E57C2' }] },
    editors: new Map(),
    teamTrails: [
      {
        owner: 'ana',
        id: 'tr1',
        name: 'Ridge',
        desc: '',
        color: '#2E8FA8',
        src: null,
        vertices: [
          { id: 'v1', lat: 46.8, lng: -71.2 },
          { id: 'v2', lat: 46.81, lng: -71.21 },
        ],
      },
      {
        owner: 'ana',
        id: 'tr2',
        name: 'Valley',
        desc: '',
        color: null,
        src: null,
        vertices: [
          { id: 'v3', lat: 46.7, lng: -71.1 },
          { id: 'v4', lat: 46.71, lng: -71.11 },
        ],
      },
    ],
  };
  return { useTeamStore: (pick: (s: typeof state) => unknown) => pick(state) };
});

function Host() {
  return <>{useTeamTrailLayers(undefined)}</>;
}

const last = (id: string) => [...mockLayers].reverse().find((l) => l.id === id);
const selOf = () => {
  const data = mockSources[mockSources.length - 1]?.data as {
    features: { properties: { trail?: string; sel?: number } }[];
  };
  return Object.fromEntries(
    data.features
      .filter((f) => f.properties.trail)
      .map((f) => [f.properties.trail, f.properties.sel]),
  );
};

beforeEach(() => {
  mockLayers.length = 0;
  mockSources.length = 0;
  useTeamSheet.setState({ sheet: null });
});

it('marks the spot card trail selected, and only while the card is up', async () => {
  await render(
    <PaperProvider>
      <Host />
    </PaperProvider>,
  );
  expect(selOf()).toEqual({ tr1: 0, tr2: 0 });

  await act(async () =>
    useTeamSheet.setState({
      sheet: { kind: 'spot', at: [-71.2, 46.8], trail: 'Ridge', team: { owner: 'ana', id: 'tr1' } },
    }),
  );
  expect(selOf()).toEqual({ tr1: 1, tr2: 0 });

  await act(async () => useTeamSheet.setState({ sheet: null }));
  expect(selOf()).toEqual({ tr1: 0, tr2: 0 });
});

it('draws a glow under a bright casing for the selected trail only', async () => {
  await render(
    <PaperProvider>
      <Host />
    </PaperProvider>,
  );
  const hl = selectionHighlight('paper');
  const glow = last('team-trl-glow');
  expect(glow?.filter).toEqual(['all', ['==', ['get', 'kind'], 'line'], ['==', ['get', 'sel'], 1]]);
  expect(glow?.paint).toMatchObject({ 'line-color': hl.glow.color, 'line-blur': hl.glow.blur });
  const casing = last('team-trl-casing')?.paint as Record<string, unknown[]>;
  expect(casing['line-color']?.[2]).toBe(hl.casing.color);
  expect(casing['line-width']?.slice(2)).toEqual([hl.casing.width, 7]);
  const line = last('team-trl-line')?.paint as Record<string, unknown[]>;
  expect(line['line-width']?.slice(2)).toEqual([hl.line.width, 4]);
});
