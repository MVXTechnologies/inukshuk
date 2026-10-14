import { ALL_EXTENSION_KEYS } from '@core/extensions/keys';

import { EXTENSION_PANELS } from './panelEntries';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

describe('Map overlays › Extensions', () => {
  it('has a row and a sub-panel for every registered extension, map and device alike', () => {
    for (const key of ALL_EXTENSION_KEYS) {
      expect(typeof EXTENSION_PANELS[key].Entry).toBe('function');
      expect(typeof EXTENSION_PANELS[key].Panel).toBe('function');
    }
  });
});
