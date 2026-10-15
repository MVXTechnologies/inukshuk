import { ALL_EXTENSION_KEYS } from '@core/extensions/keys';
import {
  BUILT_IN_SUB_PANEL_TAB,
  OVERLAY_ROW_PANEL,
  OVERLAY_ROW_TAB,
  OVERLAY_TABS,
  OVERLAY_TAB_LABEL,
  OVERLAY_TAB_SHORT,
  panelForRow,
  sanitizeOverlayTab,
  tabForRow,
  tabForSubPanel,
  type OverlayRow,
} from './overlayTabs';

describe('overlay tabs', () => {
  it('has the owner’s four tabs in order, with compact labels', () => {
    expect(OVERLAY_TABS).toEqual(['map', 'terrain', 'sports', 'extensions']);
    expect(OVERLAY_TABS.map((t) => OVERLAY_TAB_SHORT[t])).toEqual([
      'Map',
      'Terrain',
      'Sports',
      'Ext.',
    ]);
    expect(OVERLAY_TAB_LABEL.extensions).toBe('Extensions');
  });

  it('places every row in its tab', () => {
    expect(tabForRow('content')).toBe('map');
    expect(tabForRow('imagery')).toBe('terrain');
    expect(tabForRow('basemap')).toBe('terrain');
    expect(tabForRow('seeThroughWhite')).toBe('map');
    expect(tabForRow('heatmap')).toBe('sports');
    expect(tabForRow('weather')).toBe('sports');
    expect(tabForRow('geodeticFilter')).toBe('extensions');
    expect(tabForRow('tides')).toBe('extensions');
    for (const tab of Object.values(OVERLAY_ROW_TAB)) expect(OVERLAY_TABS).toContain(tab);
  });

  it('restores a remembered tab; junk and old settings fall back to Map', () => {
    expect(sanitizeOverlayTab('sports')).toBe('sports');
    expect(sanitizeOverlayTab(undefined)).toBe('map');
    expect(sanitizeOverlayTab('topology')).toBe('map');
    expect(sanitizeOverlayTab(3)).toBe('map');
  });

  it('puts every sub-panel in a tab: built-ins in theirs, extensions in Extensions', () => {
    expect(tabForSubPanel('satellite')).toBe('terrain');
    expect(tabForSubPanel('pdfMaps')).toBe('map');
    expect(tabForSubPanel('weather')).toBe('sports');
    for (const key of ALL_EXTENSION_KEYS) expect(tabForSubPanel(key)).toBe('extensions');
    for (const tab of Object.values(BUILT_IN_SUB_PANEL_TAB)) expect(OVERLAY_TABS).toContain(tab);
  });

  it('opens the sub-panel a row lives in, on that panel’s own tab', () => {
    expect(panelForRow('seeThroughWhite')).toBe('pdfMaps');
    expect(panelForRow('satelliteLabels')).toBe('satellite');
    expect(panelForRow('imagery')).toBe('satellite');
    expect(panelForRow('geodeticFilter')).toBe('geodetic');
    expect(panelForRow('parks')).toBeNull();
    expect(panelForRow('slope')).toBeNull();
    expect(panelForRow('slopeOptions')).toBe('slope');
    expect(tabForSubPanel('slope')).toBe('terrain');
    for (const [row, panel] of Object.entries(OVERLAY_ROW_PANEL)) {
      if (panel === undefined) continue;
      expect(tabForRow(row as OverlayRow)).toBe(tabForSubPanel(panel));
    }
  });
});
