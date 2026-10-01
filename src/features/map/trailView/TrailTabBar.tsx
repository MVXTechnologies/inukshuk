import { TRAIL_VIEW_TAB_LABELS, type TrailViewTab } from '@core/library/trailViewTabs';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

interface Props {
  tabs: readonly TrailViewTab[];
  active: TrailViewTab;
  onChange: (tab: TrailViewTab) => void;
}

/** Overview · Timeline · Splits · Notes — an underlined tab row (board C). */
export function TrailTabBar({ tabs, active, onChange }: Props) {
  const t = useSchemeTokens();
  return (
    <View
      style={[styles.row, { backgroundColor: t.surface, borderBottomColor: t.outlineVariant }]}
      accessibilityRole="tablist"
    >
      {tabs.map((tab) => {
        const on = tab === active;
        return (
          <Pressable
            key={tab}
            onPress={() => onChange(tab)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            testID={`trail-tab-${tab}`}
            style={[styles.tab, { borderBottomColor: on ? t.library.onMapBorder : 'transparent' }]}
          >
            <Text
              style={[styles.label, on ? styles.labelOn : null, { color: on ? t.ink : t.inkMuted }]}
            >
              {TRAIL_VIEW_TAB_LABELS[tab]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tab: {
    flex: 1,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 3,
  },
  label: { fontSize: 14 },
  labelOn: { fontWeight: '800' },
});
