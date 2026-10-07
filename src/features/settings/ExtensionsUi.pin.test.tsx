/**
 * Pins the rendered trees of the extension screens (Settings → Extensions and
 * the overlays sheet's Extensions tab) in every install state, light and
 * dark: the extension registry refactor (architecture review P1-3) must leave
 * them element-for-element, prop-for-prop identical. Each snapshot is the
 * SHA-256 of the rendered tree's JSON (the full trees are ~1 MB), with every
 * `style` prop flattened (`[a, false, b]` and `[a, b]` draw the same pixels)
 * and image paths cut to `assets/…` (they are relative to the checkout).
 * To see what moved, snapshot the normalized tree itself on both sides and
 * compare.
 */
import { setExtensionsForTest } from '@features/map/extensionStyles.testUtils';
import { ExtensionsPanel } from '@features/map/components/ExtensionsPanel';
import { useExtensionSyncStore } from '@state/extensionSyncStore';
import { useGeodeticStore } from '@state/geodeticStore';
import { useOfflineStore } from '@state/offlineStore';
import { useSettingsStore } from '@state/settingsStore';
import { render } from '@testing-library/react-native';
import { createHash } from 'crypto';
import { StyleSheet } from 'react-native';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';

import { ExtensionsSection } from './ExtensionsSection';

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
// The pins are the MAP extensions' trees: the external GNSS receiver (#588), a
// device extension listed after them, has its own tests (GnssSettings.test.tsx).
jest.mock('@data/gnss/link', () => ({
  ...jest.requireActual('@data/gnss/link'),
  gnssLinkAvailable: () => false,
}));
jest.mock('@data/offline', () => ({
  listCompanionPacks: jest.fn(async () => []),
  listRegionPacks: jest.fn(async () => []),
  deleteCompanionPacks: jest.fn(async () => undefined),
  createRegionPack: jest.fn(async () => undefined),
}));

/** The tree with every `style` prop flattened (what is drawn, not how it was spelled). */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  // Bundled images resolve to a path relative to the checkout (`testUri`):
  // keep it from `assets/` on, so the hash is the same on every machine.
  if (typeof node === 'string') return node.replace(/^.*?\/(?=assets\/)/, '');
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'props' && v !== null && typeof v === 'object') {
      const props: Record<string, unknown> = { ...(v as Record<string, unknown>) };
      if ('style' in props) props.style = StyleSheet.flatten(props.style as never);
      out[k] = normalize(props);
    } else {
      out[k] = normalize(v);
    }
  }
  return out;
}

const treeHash = (tree: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(normalize(tree)))
    .digest('hex')
    .slice(0, 16);

const STATES = {
  none: { geoInstalled: false, tidesInstalled: false },
  geodetic: { geoInstalled: true, tidesInstalled: false },
  tides: { geoInstalled: false, tidesInstalled: true },
  both: { geoInstalled: true, tidesInstalled: true },
};

beforeEach(() => {
  global.fetch = jest.fn(async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  useSettingsStore.setState({ hydrated: true });
  useGeodeticStore.setState({ coverage: null });
  useExtensionSyncStore.setState({ byKey: {} });
  useOfflineStore.setState({ regions: [] });
});

for (const [name, s] of Object.entries(STATES)) {
  for (const shown of [true, false]) {
    for (const dark of [false, true]) {
      const label = `${name}, ${shown ? 'shown' : 'hidden'}, ${dark ? 'dark' : 'light'}`;
      it(`Settings → Extensions: ${label}`, async () => {
        setExtensionsForTest({ ...s, geoOffline: shown, geoShown: shown, tidesShown: shown });
        const view = await render(
          <PaperProvider theme={dark ? MD3DarkTheme : MD3LightTheme}>
            <ExtensionsSection />
          </PaperProvider>,
        );
        expect(treeHash(view.toJSON())).toMatchSnapshot();
      });

      it(`Overlays › Extensions: ${label}`, async () => {
        setExtensionsForTest({ ...s, geoOffline: shown, geoShown: shown, tidesShown: shown });
        const view = await render(
          <PaperProvider theme={dark ? MD3DarkTheme : MD3LightTheme}>
            <ExtensionsPanel onOpenGeodeticFilter={() => undefined} onClose={() => undefined} />
          </PaperProvider>,
        );
        expect(treeHash(view.toJSON())).toMatchSnapshot();
      });
    }
  }
}
