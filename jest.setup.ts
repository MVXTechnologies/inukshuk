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
