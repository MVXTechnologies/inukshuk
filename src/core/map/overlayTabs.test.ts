import {
  OVERLAY_ROW_TAB,
  OVERLAY_TABS,
  OVERLAY_TAB_LABEL,
  OVERLAY_TAB_SHORT,
  sanitizeOverlayTab,
  tabForRow,
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
    expect(tabForRow('imagery')).toBe('map');
    expect(tabForRow('seeThroughWhite')).toBe('terrain');
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
});
