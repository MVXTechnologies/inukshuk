import {
  MINIMAL_TAB_BAR_CONTENT_HEIGHT,
  buildTabBarOptions,
  type TabBarColors,
} from './tabBarStyle';

const colors: TabBarColors = {
  surface: '#101010',
  outline: '#303030',
  primary: '#4c7a4c',
  tertiary: '#5a86b0',
  onSurfaceVariant: '#b0b0b0',
};

/** iPhone with a home indicator (Face ID). */
const FACE_ID_INSET = { bottom: 34 };
/** Home-button iPhone / Android with 3-button navigation. */
const NO_INSET = { bottom: 0 };

describe('buildTabBarOptions — minimal', () => {
  it('adds the bottom safe-area inset to the fixed bar height (#251)', () => {
    const { tabBarStyle } = buildTabBarOptions({
      uiStyle: 'minimal',
      colors,
      insets: FACE_ID_INSET,
    });

    // The whole bug: a bare `height: 56` replaces React Navigation's computed
    // `base + insets.bottom`, so the 34pt inset ate the label row.
    expect(tabBarStyle.height).toBe(MINIMAL_TAB_BAR_CONTENT_HEIGHT + 34);
    expect(tabBarStyle.paddingBottom).toBe(34);
  });

  it('stays compact when there is no bottom inset', () => {
    const { tabBarStyle } = buildTabBarOptions({
      uiStyle: 'minimal',
      colors,
      insets: NO_INSET,
    });

    expect(tabBarStyle.height).toBe(MINIMAL_TAB_BAR_CONTENT_HEIGHT);
    expect(tabBarStyle.paddingBottom).toBe(0);
  });

  it('leaves the same 56pt of content height whatever the inset', () => {
    const withInset = buildTabBarOptions({ uiStyle: 'minimal', colors, insets: FACE_ID_INSET });
    const withoutInset = buildTabBarOptions({ uiStyle: 'minimal', colors, insets: NO_INSET });

    const content = (s: { height?: unknown; paddingBottom?: unknown }) =>
      (s.height as number) - (s.paddingBottom as number);

    expect(content(withInset.tabBarStyle)).toBe(MINIMAL_TAB_BAR_CONTENT_HEIGHT);
    expect(content(withoutInset.tabBarStyle)).toBe(MINIMAL_TAB_BAR_CONTENT_HEIGHT);
  });

  it('clamps a negative inset instead of shrinking the bar', () => {
    const { tabBarStyle } = buildTabBarOptions({
      uiStyle: 'minimal',
      colors,
      insets: { bottom: -10 },
    });

    expect(tabBarStyle.height).toBe(MINIMAL_TAB_BAR_CONTENT_HEIGHT);
    expect(tabBarStyle.paddingBottom).toBe(0);
  });

  it('hides the icons and centres the label in the remaining space', () => {
    const options = buildTabBarOptions({ uiStyle: 'minimal', colors, insets: FACE_ID_INSET });

    expect(options.tabBarIconStyle).toEqual({ display: 'none' });
    // Auto margins centre the label: the library lays tab items out with
    // `justifyContent: 'flex-start'`, so without this it hugs the top edge.
    expect(options.tabBarLabelStyle).toEqual({
      fontSize: 13,
      fontWeight: '500',
      marginVertical: 'auto',
    });
  });

  it('uses the primary tint, like classic', () => {
    const options = buildTabBarOptions({ uiStyle: 'minimal', colors, insets: FACE_ID_INSET });

    expect(options.tabBarActiveTintColor).toBe(colors.primary);
    expect(options.tabBarInactiveTintColor).toBe(colors.onSurfaceVariant);
  });
});

describe('buildTabBarOptions — classic and edge are unchanged by #251', () => {
  // Snapshot of exactly what `app/(tabs)/_layout.tsx` produced before the fix.
  // If one of these grows a `height`, a `paddingBottom`, or an icon/label
  // style, the non-minimal bars have silently moved.
  it.each([
    ['classic' as const, colors.primary],
    ['edge' as const, colors.tertiary],
  ])('%s renders the pre-fix options', (uiStyle, activeTint) => {
    for (const insets of [FACE_ID_INSET, NO_INSET]) {
      expect(buildTabBarOptions({ uiStyle, colors, insets })).toEqual({
        tabBarActiveTintColor: activeTint,
        tabBarInactiveTintColor: colors.onSurfaceVariant,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.outline,
        },
      });
    }
  });

  it.each(['classic' as const, 'edge' as const])(
    '%s does not pin a height, so React Navigation adds the inset itself',
    (uiStyle) => {
      const { tabBarStyle } = buildTabBarOptions({ uiStyle, colors, insets: FACE_ID_INSET });

      expect(tabBarStyle.height).toBeUndefined();
      expect(tabBarStyle.paddingBottom).toBeUndefined();
    },
  );

  it.each(['classic' as const, 'edge' as const])('%s keeps the tab icons', (uiStyle) => {
    const options = buildTabBarOptions({ uiStyle, colors, insets: FACE_ID_INSET });

    expect(options.tabBarIconStyle).toBeUndefined();
    expect(options.tabBarLabelStyle).toBeUndefined();
  });
});
