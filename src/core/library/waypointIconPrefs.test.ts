import {
  EMPTY_WAYPOINT_ICON_PREFS,
  MAX_RECENT_ICONS,
  SUGGESTED_ICONS,
  quickRowIcons,
  sanitizeWaypointIconPrefs,
  withFavoriteToggled,
  withRecentIcon,
} from './waypointIconPrefs';

describe('waypoint icon prefs (#675)', () => {
  it('sanitizes a settings value: unknown ids, repeats and junk are dropped', () => {
    expect(
      sanitizeWaypointIconPrefs({
        favorites: ['camp', 'camp', 'from-the-future', 3, 'water'],
        recents: 'nope',
      }),
    ).toEqual({ favorites: ['camp', 'water'], recents: [] });
    expect(sanitizeWaypointIconPrefs(null)).toEqual(EMPTY_WAYPOINT_ICON_PREFS);
    expect(sanitizeWaypointIconPrefs([1, 2])).toEqual(EMPTY_WAYPOINT_ICON_PREFS);
  });

  it('caps recents at five, newest first, without repeats', () => {
    let p = EMPTY_WAYPOINT_ICON_PREFS;
    for (const i of ['camp', 'water', 'fire', 'bike', 'ski', 'bus', 'water'] as const) {
      p = withRecentIcon(p, i);
    }
    expect(p.recents).toEqual(['water', 'bus', 'ski', 'bike', 'fire']);
    expect(p.recents).toHaveLength(MAX_RECENT_ICONS);
  });

  it('returns the same object when the pick is already the newest recent', () => {
    const p = withRecentIcon(EMPTY_WAYPOINT_ICON_PREFS, 'camp');
    expect(withRecentIcon(p, 'camp')).toBe(p);
  });

  it('stars and unstars', () => {
    const a = withFavoriteToggled(EMPTY_WAYPOINT_ICON_PREFS, 'camp');
    const b = withFavoriteToggled(a, 'water');
    expect(b.favorites).toEqual(['water', 'camp']);
    expect(withFavoriteToggled(b, 'camp').favorites).toEqual(['water']);
  });

  it('builds the quick row: current, favourites, recents, no repeats', () => {
    const prefs = { favorites: ['fire', 'bike'], recents: ['bike', 'ski'] } as const;
    const p = { favorites: [...prefs.favorites], recents: [...prefs.recents] };
    expect(quickRowIcons('camp', p)).toEqual(['camp', 'fire', 'bike', 'ski']);
    // The current icon already in a list is not added twice.
    expect(quickRowIcons('ski', p)).toEqual(['fire', 'bike', 'ski', 'camp']);
    expect(quickRowIcons(undefined, p, 2)).toEqual(['fire', 'bike']);
  });

  it('starts a new user on the suggested icons', () => {
    expect(quickRowIcons(undefined, EMPTY_WAYPOINT_ICON_PREFS)).toEqual([...SUGGESTED_ICONS]);
  });
});
