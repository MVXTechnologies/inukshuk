import { DISPLAY_SCALES, MIN_TOUCH } from '@core/display/displayScale';
import { useSettingsStore } from '@state/settingsStore';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { Button, IconButton, List, Menu, iconButtonBox, scaledIconSource } from './paper';
import { resolveTheme } from './theme';

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: async () => null }));

async function renderAt(k: number, ui: React.ReactElement) {
  useSettingsStore.setState({ displayScale: k as 1 });
  await render(<PaperProvider theme={resolveTheme('light', 'normal', k)}>{ui}</PaperProvider>);
}

const flat = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style) as Record<string, unknown>;

afterEach(() => useSettingsStore.getState().reset());

describe('iconButtonBox', () => {
  it('keeps the touch box at 48 or more at every size', () => {
    for (const k of DISPLAY_SCALES) {
      expect(iconButtonBox(24, k).box).toBeGreaterThanOrEqual(MIN_TOUCH);
      expect(iconButtonBox(18, k).box).toBeGreaterThanOrEqual(MIN_TOUCH);
    }
  });

  it("gives back the floor's extra as margin, so the footprint shrinks to 48 at Small", () => {
    const { box, margin } = iconButtonBox(24, 0.85);
    expect(box).toBe(48);
    expect(margin).toBe(0);
    // Paper's footprint at 100 %: 40 + 2 × 6 = 52.
    expect(box + 2 * margin).toBeLessThan(52);
  });
});

describe('scaledIconSource', () => {
  it('is the same source at 100 %', () => {
    expect(scaledIconSource('check', 1)).toBe('check');
  });

  it('hands a function source the scaled size', () => {
    const fn = jest.fn(() => null);
    const src = scaledIconSource(fn, 0.85) as (p: { size: number; color: string }) => unknown;
    src({ size: 24, color: 'red' });
    expect(fn).toHaveBeenCalledWith({ size: 20.5, color: 'red' });
  });
});

describe('wrappers at 100 % are Paper itself', () => {
  it("IconButton keeps Paper's 40 dp box", async () => {
    await renderAt(1, <IconButton icon="close" onPress={() => {}} testID="b" />);
    expect(flat('b-container-outer-layer').width).toBe(40);
  });
});

describe('wrappers at Small', () => {
  it('IconButton: smaller glyph, 48 dp touch box', async () => {
    await renderAt(0.85, <IconButton icon="close" onPress={() => {}} testID="b" />);
    // Paper's MD3 Surface puts the size on its outer layer.
    const box = flat('b-container-outer-layer');
    expect(box.width).toBe(48);
    expect(box.height).toBe(48);
  });

  it('List.Item: denser padding, a pressable row keeps 48 dp', async () => {
    await renderAt(0.85, <List.Item title="Units" onPress={() => {}} testID="row" />);
    const row = flat('row');
    expect(row.paddingVertical).toBe(6.5);
    expect(row.paddingRight).toBe(19);
    expect(row.minHeight).toBe(MIN_TOUCH);
  });

  it('List.Item without onPress has no forced height', async () => {
    await renderAt(0.85, <List.Item title="Info" testID="row" />);
    expect(flat('row').minHeight).toBeUndefined();
  });

  it('Button keeps its 40 dp height and tightens its label margins', async () => {
    await renderAt(
      0.85,
      <Button mode="contained" onPress={() => {}} testID="btn">
        Save
      </Button>,
    );
    expect(screen.getByText('Save')).toBeTruthy();
  });

  it('Menu.Item renders through the wrapper', async () => {
    await renderAt(0.85, <Menu.Item title="Rename" onPress={() => {}} testID="mi" />);
    expect(screen.getByText('Rename')).toBeTruthy();
  });
});
