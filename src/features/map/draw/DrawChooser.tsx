import { palette, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

/**
 * "Draw" (the map's "+" menu): pick what to draw — a Route (a line) or an
 * Area (a polygon). One menu row instead of two; this small sheet then asks.
 *
 * A plain themed View docked at the bottom like the other map sheets — no
 * Paper Dialog or Portal (an invisible overlay swallows touches on One UI
 * when animations are off).
 */

interface Option {
  id: 'route' | 'area';
  icon: string;
  label: string;
  hint: string;
}

const OPTIONS: readonly Option[] = [
  {
    id: 'route',
    icon: 'vector-polyline',
    label: 'Route',
    hint: 'A line to follow, snapped to trails or roads',
  },
  {
    id: 'area',
    icon: 'vector-polygon',
    label: 'Area',
    hint: 'A shape to mark a zone on the map',
  },
];

export function DrawChooser({
  onPick,
  onClose,
}: {
  onPick: (kind: 'route' | 'area') => void;
  onClose: () => void;
}) {
  const t = useSchemeTokens();
  return (
    <View
      style={[styles.sheet, { backgroundColor: t.surface, shadowColor: palette.shadow }]}
      testID="draw-chooser"
    >
      <View style={styles.titleRow}>
        <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
          Draw
        </Text>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={8}
          style={styles.close}
        >
          <Icon source="close" size={22} color={t.inkMuted} />
        </Pressable>
      </View>
      {OPTIONS.map((o) => (
        <Pressable
          key={o.id}
          onPress={() => onPick(o.id)}
          accessibilityRole="button"
          accessibilityLabel={o.label}
          accessibilityHint={o.hint}
          style={({ pressed }) => [
            styles.option,
            { borderColor: t.outlineVariant },
            pressed && { backgroundColor: t.library.chipOn },
          ]}
        >
          <View style={[styles.iconWell, { backgroundColor: t.library.chipOn }]}>
            <Icon source={o.icon} size={24} color={t.library.chipOnInk} />
          </View>
          <View style={styles.text}>
            <Text style={[styles.label, { color: t.ink }]}>{o.label}</Text>
            <Text style={[styles.hint, { color: t.inkMuted }]} numberOfLines={1}>
              {o.hint}
            </Text>
          </View>
          <Icon source="chevron-right" size={22} color={t.inkMuted} />
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 18,
    gap: 10,
    elevation: 8,
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: -2 },
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', minHeight: 36 },
  title: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '800' },
  close: { width: 40, height: 36, alignItems: 'flex-end', justifyContent: 'center' },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: target.min + 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1.5,
  },
  iconWell: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, gap: 2 },
  label: { fontSize: 16, lineHeight: 20, fontWeight: '800' },
  hint: { fontSize: 13, lineHeight: 17 },
});
