import { buildTabBarOptions, type TabBarColors } from './tabBarStyle';

const colors: TabBarColors = {
  surface: '#101010',
  outline: '#303030',
  active: '#4c7a4c',
  inactive: '#b0b0b0',
};

describe('buildTabBarOptions', () => {
  it('maps the theme colours onto the tab bar', () => {
    expect(buildTabBarOptions({ colors })).toEqual({
      tabBarActiveTintColor: colors.active,
      tabBarInactiveTintColor: colors.inactive,
      tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.outline },
    });
  });

  // #251: a pinned height replaces React Navigation's `base + insets.bottom`
  // and the inset then eats the label row.
  it('never pins a height or bottom padding', () => {
    const { tabBarStyle } = buildTabBarOptions({ colors });
    expect(tabBarStyle.height).toBeUndefined();
    expect(tabBarStyle.paddingBottom).toBeUndefined();
  });
});
