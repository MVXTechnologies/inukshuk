// Global Jest setup.
//
// @testing-library/react-native v14 ships its own matchers, so we only need to
// register lightweight native-module mocks that some libraries touch at import
// time. Pure-logic tests under src/core need none of this but it is harmless.
//
// Note: console.warn is intentionally NOT silenced here — a blanket mock hides
// real regressions (deprecations, act() warnings, bad-prop warnings). If a
// dependency emits a genuinely unavoidable warning, filter that exact message
// here with a comment explaining why.

// Gesture Handler's own Jest mocks: the recording panel's swipe uses a
// GestureDetector, whose native module does not exist under Jest.
import 'react-native-gesture-handler/jestSetup';

// Resolve every lazy global while this test file's environment is still live.
// Expo's winter runtime installs `fetch` (and friends) as lazy getters that
// `require` their module on first read, and jest-runtime's teardown reads
// EVERY global (Runtime.resetModules: Object.keys(global).forEach(...)) to
// clear mocks. A file that never touched `fetch` therefore required
// expo-modules-core during teardown, after the native-module mocks were gone:
// its JS-logger setup warned "An error occurred while requiring the
// 'ExpoModulesCoreJSLogger' module", which Jest reported as "Cannot log after
// tests are done" on every CI run. Reading the globals here does the same
// reads at a time they can succeed silently.
afterAll(() => {
  for (const key of Object.keys(globalThis)) {
    void (globalThis as Record<string, unknown>)[key];
  }
});

// Reanimated 4 (InukshukLoader). Its native entry needs the Worklets native
// module, which does not exist under Jest: swap both packages for their own
// shipped mocks (hooks run their worklet once, synchronously; animations
// resolve to their target). The mock leaves out `useReducedMotion`, so add it
// (off by default; tests flip it with jest.mocked(...).mockReturnValue), and
// make `cancelAnimation` a spy so unmount cleanup can be asserted.
jest.mock('react-native-worklets', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('react-native-worklets/src/mock'),
);
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ...require('react-native-reanimated/mock'),
  useReducedMotion: jest.fn(() => false),
  cancelAnimation: jest.fn(),
}));

// Apple Health / Health Connect are Nitro native modules that do not exist
// under Jest, and Jest resolves `@lib/health/platform` with the iOS extension.
// Screens that offer Health import (Library, Settings) get an inert platform
// ("no health store on this device"); tests that exercise Health mock
// `@lib/health` (or `./platform`) themselves, which overrides this.
jest.mock('@lib/health/platform', () => ({ healthPlatform: null }));

// expo-secure-store (Strava tokens, NTRIP passwords): jest-expo's automock
// answers undefined to everything; an in-memory keychain behaves like the
// real one. Cleared before each test; `globalThis.__secureStore` is the map.
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  (globalThis as { __secureStore?: Map<string, string> }).__secureStore = store;
  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    deleteItemAsync: jest.fn(async (k: string) => {
      store.delete(k);
    }),
  };
});
beforeEach(() => (globalThis as { __secureStore?: Map<string, string> }).__secureStore?.clear());
