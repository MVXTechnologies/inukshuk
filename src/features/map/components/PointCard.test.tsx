/**
 * The normal-mode long-press card (#757 c): the shared grid with five cells,
 * in both themes, its header never cut, each cell running its action.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';

import { FLOATING_CARD_GAP } from '../bottomLayers';
import { POINT_CARD_CELLS, PointCard, pointShareText, type PointCardAction } from './PointCard';

const wrap = (dark: boolean, floating = false, onAction = jest.fn(), onClose = jest.fn()) => (
  <PaperProvider theme={dark ? MD3DarkTheme : MD3LightTheme}>
    <PointCard
      coords="46.812044, -71.230118"
      readout="1.2 km · NE"
      floating={floating}
      onAction={onAction}
      onClose={onClose}
    />
  </PaperProvider>
);

const cellIds = () =>
  screen
    .getByTestId('point-card-grid')
    .children.map((c) => (typeof c === 'string' ? c : (c.props.testID as string)));

describe('the point card (#757 c)', () => {
  it.each([false, true])(
    'Waypoint, Navigate, Copy, Convert, Share, five a row (dark: %s)',
    async (dark) => {
      await render(wrap(dark));
      expect(cellIds()).toEqual([
        'point-card-waypoint',
        'point-card-navigate',
        'point-card-copy',
        'point-card-convert',
        'point-card-share',
      ]);
      for (const { label } of POINT_CARD_CELLS) {
        const text = screen.getByText(label);
        expect(text.props.numberOfLines).toBe(2);
        expect(text.props.maxFontSizeMultiplier).toBe(1.15);
      }
      for (const id of cellIds())
        expect(StyleSheet.flatten(screen.getByTestId(id).props.style).width).toBe('20%');
    },
  );

  it('says where, from my fix, on up to two lines', async () => {
    await render(wrap(false));
    const coords = screen.getByTestId('point-card-coords');
    expect(coords).toHaveTextContent('46.812044, -71.230118 · 1.2 km · NE');
    expect(coords.props.numberOfLines).toBe(2);
  });

  it('each cell runs its action; ✕ closes', async () => {
    const onAction = jest.fn<void, [PointCardAction]>();
    const onClose = jest.fn();
    await render(wrap(false, false, onAction, onClose));
    for (const { k } of POINT_CARD_CELLS)
      await fireEvent.press(screen.getByTestId(`point-card-${k}`));
    expect(onAction.mock.calls.map((c) => c[0])).toEqual([
      'waypoint',
      'navigate',
      'copy',
      'convert',
      'share',
    ]);
    await fireEvent.press(screen.getByTestId('point-card-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the side gaps on the bare map; over the recording panel the dock does', async () => {
    await render(wrap(false));
    expect(StyleSheet.flatten(screen.getByTestId('point-card').props.style)).toMatchObject({
      marginHorizontal: FLOATING_CARD_GAP,
    });
    await render(wrap(false, true));
    expect(
      StyleSheet.flatten(screen.getByTestId('point-card').props.style).marginHorizontal,
    ).toBeUndefined();
  });

  it('shares the coordinates as shown and a geo: link', () => {
    expect(pointShareText('46°48′43″N 71°13′48″W', 46.8120441, -71.2301184)).toBe(
      '46°48′43″N 71°13′48″W\ngeo:46.812044,-71.230118',
    );
  });
});
