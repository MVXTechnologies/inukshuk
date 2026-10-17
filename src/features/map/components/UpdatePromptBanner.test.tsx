import { DISPLAY_SCALES, osFontCap, scaleFontSize } from '@core/display/displayScale';
import { fitsOneLine, rowRoomDp, textAdvanceDp } from '@core/display/textFit';
import { DisplayScaleProvider } from '@ui/displayScale';
import { darkTheme, lightTheme } from '@ui/theme';
import { darkScheme, lightScheme } from '@ui/tokens';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { UPDATE_PROMPT_ROW, UpdatePromptBanner } from './UpdatePromptBanner';

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: jest.fn(async () => null) }));

async function renderBanner({
  dark = false,
  factor = 1,
  action = 'Update' as string | null,
  text = 'Version 2.7.1 available',
} = {}) {
  const onAction = jest.fn();
  const onDismiss = jest.fn();
  await render(
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <DisplayScaleProvider factor={factor}>
        <UpdatePromptBanner
          text={text}
          action={action}
          actionLabel={action === null ? null : 'Update Inukshuk'}
          onAction={onAction}
          onDismiss={onDismiss}
        />
      </DisplayScaleProvider>
    </PaperProvider>,
  );
  return { onAction, onDismiss };
}

describe('UpdatePromptBanner', () => {
  it('is one line, an Update button and a close button', async () => {
    const { onAction, onDismiss } = await renderBanner();
    expect(screen.getByText('Version 2.7.1 available')).toBeOnTheScreen();
    expect(screen.getByText('Version 2.7.1 available').props.numberOfLines).toBe(1);
    await fireEvent.press(screen.getByLabelText('Update Inukshuk'));
    expect(onAction).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByLabelText('Close'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('has no button while the download runs', async () => {
    await renderBanner({ action: null, text: 'Downloading update · 40 %' });
    expect(screen.getByText('Downloading update · 40 %')).toBeOnTheScreen();
    expect(screen.queryByTestId('update-prompt-action')).toBeNull();
    expect(screen.getByLabelText('Close')).toBeOnTheScreen();
  });

  it.each([
    ['light', false, lightScheme],
    ['dark', true, darkScheme],
  ] as const)('wears the %s map chrome, the button its colours swapped', async (_n, dark, s) => {
    await renderBanner({ dark });
    const card = StyleSheet.flatten(screen.getByTestId('update-prompt').props.style);
    expect(card.backgroundColor).toBe(s.map.chrome);
    const button = StyleSheet.flatten(screen.getByTestId('update-prompt-action').props.style);
    expect(button.backgroundColor).toBe(s.map.chromeInk);
    expect(StyleSheet.flatten(screen.getByText('Update').props.style).color).toBe(s.map.chrome);
  });

  it.each(DISPLAY_SCALES.map((k) => [k]))('scales its text with Display size %p', async (k) => {
    await renderBanner({ factor: k });
    const style = StyleSheet.flatten(screen.getByText('Version 2.7.1 available').props.style);
    expect(style.fontSize).toBe(scaleFontSize(UPDATE_PROMPT_ROW.textSp, k));
  });
});

/**
 * "If it fits, it fits" (#760): the line and its button on one row on a
 * 360 dp phone at Small, Default and Large, with the OS font at the cap.
 * Advances in em of Atkinson Hyperlegible Next, measured from
 * `assets/fonts/*.ttf` (PIL `ImageFont.getlength`): text 500, button 700.
 */
const EM = {
  versionAvailable: 10.018, // "Version 2.7.1 available"
  newVersion: 9.88, // "New version available"
  downloaded: 9.05, // "Update downloaded"
  downloading: 13.096, // "Downloading update · 100 %"
  update: 3.369, // "Update"
  restart: 3.401, // "Restart"
};

describe.each(DISPLAY_SCALES.map((k) => [k]))('one row at 360 dp, Display size %p', (k) => {
  const os = Math.min(1.3, osFontCap(k) ?? 1.3);
  /** The bottom column's 16 dp insets either side, then the card's row. */
  const room = (button: number | null) =>
    rowRoomDp(
      360,
      { spacing: [16, 16, ...UPDATE_PROMPT_ROW.spacing], boxes: UPDATE_PROMPT_ROW.boxes },
      k,
    ) - (button === null ? 0 : textAdvanceDp(button, UPDATE_PROMPT_ROW.buttonSp, k, os));
  const fits = (em: number, button: number | null) =>
    fitsOneLine(em, UPDATE_PROMPT_ROW.textSp, room(button), k, os);

  it('the offer beside Update', () => {
    expect(fits(EM.versionAvailable, EM.update)).toBe(true);
    expect(fits(EM.newVersion, EM.update)).toBe(true);
  });

  it('the download, then Restart', () => {
    expect(fits(EM.downloading, null)).toBe(true);
    expect(fits(EM.downloaded, EM.restart)).toBe(true);
  });
});
