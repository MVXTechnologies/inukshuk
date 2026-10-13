import { darkTheme, lightTheme } from '@ui/theme';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { weatherChrome } from '../weather/weatherChrome';
import { FollowChip } from './FollowChip';

describe('FollowChip', () => {
  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ])('says what is followed and stops on ✕ (%s theme: the fixed dark slab)', async (_n, theme) => {
    const onStop = jest.fn();
    await render(
      <PaperProvider theme={theme}>
        <FollowChip name="Sentier des Crêtes" onStop={onStop} />
      </PaperProvider>,
    );
    const text = screen.getByText('Following · Sentier des Crêtes');
    expect(StyleSheet.flatten(text.props.style).color).toBe(weatherChrome.ink);
    await fireEvent.press(screen.getByLabelText('Stop following'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
