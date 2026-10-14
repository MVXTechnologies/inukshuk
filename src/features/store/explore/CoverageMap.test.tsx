import { render, screen } from '@testing-library/react-native';
import { lightTheme } from '@ui/theme';
import { PaperProvider } from 'react-native-paper';

import { CoverageMap, MIN_FOOTPRINT, minFootprint } from './CoverageMap';

describe('CoverageMap (2.5.2 QA: a river’s box hid under the “you” dot)', () => {
  it('grows a tiny footprint about its centre, leaves a big one alone', () => {
    expect(minFootprint({ x: 50, y: 40, width: 2, height: 1 }, 8)).toEqual({
      x: 47,
      y: 36.5,
      width: 8,
      height: 8,
    });
    const big = { x: 10, y: 10, width: 30, height: 20 };
    expect(minFootprint(big, 8)).toEqual(big);
  });

  it('draws the footprint after (over) the dot, at least the minimum size', async () => {
    // A small river box with the user standing in it.
    await render(
      <PaperProvider theme={lightTheme}>
        <CoverageMap
          bbox={[-71.33, 46.8, -71.32, 46.805]}
          position={{ latitude: 46.802, longitude: -71.325 }}
          height={150}
        />
      </PaperProvider>,
    );
    const rect = screen.getByTestId('coverage-footprint');
    expect(Number(rect.props.width)).toBeGreaterThanOrEqual(MIN_FOOTPRINT);
    expect(Number(rect.props.height)).toBeGreaterThanOrEqual(MIN_FOOTPRINT);
    const svg = rect.parent!;
    const kids = svg.children.filter((c) => typeof c !== 'string');
    const footprintAt = kids.indexOf(rect);
    const dotAt = kids.findIndex(
      (c) => typeof c !== 'string' && c.props.r !== undefined && c.props.cx !== undefined,
    );
    expect(dotAt).toBeGreaterThanOrEqual(0);
    expect(footprintAt).toBeGreaterThan(dotAt);
  });
});
