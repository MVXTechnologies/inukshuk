import { ALL_EXTENSION_KEYS } from '@core/extensions/keys';

import { EXTENSION_PANEL_ENTRIES } from './panelEntries';

describe('Map overlays › Extensions', () => {
  it('has a row for every registered extension, map and device alike', () => {
    for (const key of ALL_EXTENSION_KEYS) {
      expect(typeof EXTENSION_PANEL_ENTRIES[key]).toBe('function');
    }
  });
});
