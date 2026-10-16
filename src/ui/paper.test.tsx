import { DISPLAY_SCALES, MIN_TOUCH } from '@core/display/displayScale';
import { useSettingsStore } from '@state/settingsStore';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import {
  Button,
  IconButton,
  List,
  Menu,
  buttonHeight,
  buttonHitSlop,
  iconButtonBox,
  scaledIconSource,
} from './paper';
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

  it('passes a function source through: it draws with the scaled Icon itself', () => {
    const fn = jest.fn(() => null);
    expect(scaledIconSource(fn, 0.85)).toBe(fn);
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

  it.each(DISPLAY_SCALES.map((k) => [k]))(
    'Button: drawn height + hitSlop reaches 48 dp at %p',
    async (k) => {
      await renderAt(
        k,
        <Button mode="contained" onPress={() => {}} testID="btn">
          Save
        </Button>,
      );
      const slop = screen.getByTestId('btn').props.hitSlop as { top: number; bottom: number };
      expect(buttonHeight(k) + slop.top + slop.bottom).toBeGreaterThanOrEqual(MIN_TOUCH);
    },
  );

  it("Button: a caller's own hitSlop wins", async () => {
    await renderAt(
      0.85,
      <Button onPress={() => {}} testID="btn" hitSlop={2}>
        Save
      </Button>,
    );
    expect(screen.getByTestId('btn').props.hitSlop).toBe(2);
  });

  it('Button heights: 40 at Default, denser at Small, roomier at Large', () => {
    expect(buttonHeight(1)).toBe(40);
    expect(buttonHeight(0.85)).toBe(33);
    expect(buttonHeight(1.15)).toBe(48);
    expect(buttonHitSlop(1)).toEqual({ top: 4, bottom: 4 });
  });

  it('Menu.Item renders through the wrapper', async () => {
    await renderAt(0.85, <Menu.Item title="Rename" onPress={() => {}} testID="mi" />);
    expect(screen.getByText('Rename')).toBeTruthy();
  });
});
