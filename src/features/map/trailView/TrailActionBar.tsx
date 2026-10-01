import { useSchemeTokens } from '@ui/useSchemeTokens';
import { StyleSheet, View } from 'react-native';
import { Button } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface TrailAction {
  key: string;
  label: string;
  icon: string;
  onPress: () => void;
  loading?: boolean;
  /** The bar's one filled button. */
  primary?: boolean;
}

/** Height of the bar above the safe-area inset, for the scroll content's bottom padding. */
export const TRAIL_ACTION_BAR_H = 64;

/**
 * Sticky bottom bar (#511): the trail's actions — only those that exist
 * (Show on map · Share · Export today; "Follow again" waits for route
 * following).
 */
export function TrailActionBar({ actions }: { actions: readonly TrailAction[] }) {
  const t = useSchemeTokens();
  const insets = useSafeAreaInsets();
  if (actions.length === 0) return null;
  return (
    <View
      style={[
        styles.bar,
        {
          paddingBottom: insets.bottom + 10,
          backgroundColor: t.surface,
          borderTopColor: t.outlineVariant,
        },
      ]}
      testID="trail-action-bar"
    >
      {actions.map((a) => (
        <Button
          key={a.key}
          mode={a.primary ? 'contained' : 'outlined'}
          icon={a.icon}
          onPress={a.onPress}
          loading={a.loading}
          disabled={a.loading}
          compact
          style={styles.btn}
          labelStyle={styles.label}
        >
          {a.label}
        </Button>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: 8,
    paddingTop: 10,
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  btn: { flex: 1 },
  label: { fontSize: 13, marginHorizontal: 6 },
});
