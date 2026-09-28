import {
  ANDROID_MIN_BOTTOM,
  buildTabBarOptions,
  TAB_PILL,
  tabBarBottomInset,
  tabLabelStyle,
  type TabBarColors,
} from './tabBarStyle';

const colors: TabBarColors = {
  surface: '#101010',
  outline: '#303030',
  active: '#4c7a4c',
  inactive: '#b0b0b0',
};

describe('buildTabBarOptions', () => {
  it('maps the theme colours onto the tab bar and sizes the icon slot for the pill', () => {
    expect(buildTabBarOptions({ colors })).toEqual({
      tabBarActiveTintColor: colors.active,
      tabBarInactiveTintColor: colors.inactive,
      tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.outline },
      tabBarIconStyle: { width: TAB_PILL.width, height: TAB_PILL.height },
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

describe('tabLabelStyle', () => {
  it('is 12 dp in the brand face, heavier when active', () => {
    expect(tabLabelStyle(true, 'Brand')).toEqual({
      fontSize: 12,
      lineHeight: 16,
      fontFamily: 'Brand',
      fontWeight: '800',
    });
    expect(tabLabelStyle(false, 'Brand').fontWeight).toBe('700');
  });
});

describe('tabBarBottomInset', () => {
  it('keeps the labels off the screen edge on Android when the nav bar is hidden', () => {
    expect(tabBarBottomInset(0, 'android')).toBe(ANDROID_MIN_BOTTOM);
    expect(tabBarBottomInset(24, 'android')).toBe(24);
  });

  it('leaves iOS home-indicator insets alone', () => {
    expect(tabBarBottomInset(34, 'ios')).toBe(34);
    expect(tabBarBottomInset(0, 'ios')).toBe(0);
  });
});
