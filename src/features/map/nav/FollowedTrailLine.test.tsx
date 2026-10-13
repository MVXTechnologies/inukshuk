import { contrastRatio } from '@core/color/contrast';
import { render } from '@testing-library/react-native';
import { darkTheme, lightTheme } from '@ui/theme';
import { schemeTokens } from '@ui/tokens';
import type { ReactNode } from 'react';
import { PaperProvider } from 'react-native-paper';

import { FollowedTrailLine } from './FollowedTrailLine';

type Props = Record<string, unknown> & { children?: ReactNode };
const mockLayers: Props[] = [];
const mockSources: Props[] = [];

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

beforeEach(() => {
  mockLayers.length = 0;
  mockSources.length = 0;
});

const PATH: [number, number][][] = [
  [
    [-71.2, 46.8],
    [-71.21, 46.81],
  ],
];

async function draw(dark: boolean) {
  await render(
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <FollowedTrailLine path={PATH} />
    </PaperProvider>,
  );
}

const paint = (id: string) =>
  mockLayers.find((l) => l.id === id)?.paint as { 'line-color'?: string } | undefined;

describe('FollowedTrailLine (2.5.1 QA: dim on the dark map)', () => {
  it.each([
    ['light', false],
    ['dark', true],
  ])('draws the trail over a casing in the %s scheme colours', async (_n, dark) => {
    await draw(dark);
    const t = schemeTokens(dark);
    expect(mockSources[0]?.data).toMatchObject({
      geometry: { type: 'MultiLineString', coordinates: PATH },
    });
    expect(mockLayers.map((l) => l.id)).toEqual(['followed-trail-casing', 'followed-trail-line']);
    expect(paint('followed-trail-line')?.['line-color']).toBe(t.map.followedTrail);
    expect(paint('followed-trail-casing')?.['line-color']).toBe(t.map.followedTrailCasing);
  });

  it('stands out on the dark map: the line against its casing and the dark ground', () => {
    const t = schemeTokens(true);
    expect(contrastRatio(t.map.followedTrail, t.map.followedTrailCasing)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(t.map.followedTrail, t.background)).toBeGreaterThanOrEqual(3);
  });
});
