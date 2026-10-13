/**
 * One icon for Geodetic points (2.5.1 QA): the Map layers row, its sub-panel
 * and the Settings › Extensions row all draw GEODETIC_ICON — Settings used to
 * show the 3D map symbol while the sheet showed a pin.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { GEODETIC_ICON } from './icon';

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');

describe('Geodetic points icon', () => {
  it.each(['GeodeticPanelEntry.tsx', 'GeodeticSubPanel.tsx', 'GeodeticSettings.tsx'])(
    '%s names the extension with GEODETIC_ICON and no other mark',
    (file) => {
      const src = read(file);
      expect(src).toMatch(/icon=\{GEODETIC_ICON\}|badgeIcon=\{GEODETIC_ICON\}/);
      expect(src).not.toContain('geodeticImage(');
      expect(src).not.toContain(`icon="${GEODETIC_ICON}"`);
    },
  );

  it('is a MaterialCommunityIcons name', () => {
    expect(GEODETIC_ICON).toBe('map-marker-radius-outline');
  });
});
