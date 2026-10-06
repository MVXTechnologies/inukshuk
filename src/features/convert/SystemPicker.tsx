import type { PickerSection } from '@core/convert/picker';
import { radius, space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Icon, IconButton, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type PickerTab = 'coords' | 'heights';

interface Props {
  title: string;
  tab: PickerTab;
  onTab: (t: PickerTab) => void;
  sections: (query: string) => PickerSection[];
  selected: string | null;
  /** Offer "No height" (2D) in the heights tab. */
  allowNone?: boolean;
  onPick: (id: string | null) => void;
  onClose: () => void;
}

/**
 * The system picker (mockup 10): a bottom sheet over the Convert screen —
 * search by name or EPSG code, Coordinates / Heights, and sections built by
 * `@core/convert/picker` (only systems with a validated plan here are
 * listed). An in-screen overlay, never a Portal (the #108 soft-lock).
 */
export function SystemPicker({
  title,
  tab,
  onTab,
  sections,
  selected,
  allowNone,
  onPick,
  onClose,
}: Props) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const list = sections(query);
  const iconFor = (id: string) =>
    tab === 'coords'
      ? id.endsWith(':geo')
        ? 'earth'
        : id.endsWith(':xyz')
          ? 'axis-arrow'
          : 'grid'
      : id.startsWith('cd') || id.includes('@') || id === 'lat-nl'
        ? 'waves'
        : id === 'ell' || id.startsWith('egm')
          ? 'earth'
          : 'arrow-expand-vertical';

  return (
    <View style={StyleSheet.absoluteFill} testID="convert-picker">
      <Pressable
        style={[StyleSheet.absoluteFill, styles.scrim]}
        onPress={onClose}
        accessibilityLabel="Close picker"
      />
      <View
        style={[
          styles.sheet,
          { backgroundColor: theme.colors.surface, paddingBottom: insets.bottom + space.md },
        ]}
      >
        <View style={[styles.grabber, { backgroundColor: tokens.outlineVariant }]} />
        <View style={styles.titleRow}>
          <Text
            variant="titleLarge"
            style={[styles.title, { color: tokens.ink }]}
            accessibilityRole="header"
          >
            {title}
          </Text>
          <IconButton icon="close" onPress={onClose} accessibilityLabel="Close" />
        </View>
        <View style={[styles.search, { backgroundColor: theme.colors.surfaceVariant }]}>
          <Icon source="magnify" size={22} color={tokens.inkVariant} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search name or EPSG code"
            placeholderTextColor={tokens.inkMuted}
            style={[styles.searchInput, { color: tokens.ink }]}
            autoCorrect={false}
            autoCapitalize="none"
            testID="convert-picker-search"
            returnKeyType="search"
          />
        </View>
        <View style={[styles.tabs, { borderColor: tokens.outline }]}>
          {(['coords', 'heights'] as const).map((t) => (
            <Pressable
              key={t}
              onPress={() => onTab(t)}
              style={[
                styles.tab,
                tab === t && { backgroundColor: theme.colors.secondaryContainer },
              ]}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === t }}
              testID={`convert-picker-tab-${t}`}
            >
              <Text variant="labelLarge" style={{ color: tokens.ink }}>
                {t === 'coords' ? 'Coordinates' : 'Heights'}
              </Text>
            </Pressable>
          ))}
        </View>
        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {tab === 'heights' && allowNone && (
            <Row
              title="No height"
              subtitle="Horizontal position only"
              icon="minus"
              selected={selected === null}
              onPress={() => onPick(null)}
              testID="convert-pick-none"
            />
          )}
          {list.map((s) => (
            <View key={s.title}>
              <Text variant="labelMedium" style={[styles.section, { color: tokens.inkVariant }]}>
                {s.title.toUpperCase()}
              </Text>
              {s.items.map((it) => (
                <Row
                  key={it.id}
                  title={it.title}
                  subtitle={it.subtitle}
                  {...(it.badge ? { badge: it.badge } : {})}
                  icon={iconFor(it.id)}
                  selected={selected === it.id}
                  onPress={() => onPick(it.id)}
                  testID={`convert-pick-${it.id}`}
                />
              ))}
            </View>
          ))}
          {list.length === 0 && (
            <Text variant="bodyMedium" style={[styles.empty, { color: tokens.inkVariant }]}>
              Nothing validated matches here. Systems without an official-tool check are not
              offered.
            </Text>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

function Row({
  title,
  subtitle,
  badge,
  icon,
  selected,
  onPress,
  testID,
}: {
  title: string;
  subtitle: string;
  badge?: string;
  icon: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      style={[styles.row, selected && { backgroundColor: theme.colors.secondaryContainer }]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${title}, ${subtitle}`}
      testID={testID}
    >
      <Icon source={icon} size={24} color={tokens.ink} />
      <View style={styles.rowText}>
        <Text variant="titleMedium" style={{ color: tokens.ink }} numberOfLines={2}>
          {title}
        </Text>
        <Text variant="bodySmall" style={{ color: tokens.inkVariant }} numberOfLines={2}>
          {subtitle}
        </Text>
      </View>
      {badge ? (
        <Text variant="labelSmall" style={{ color: tokens.inkVariant }}>
          {badge}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: 'rgba(20,24,28,0.45)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    top: '16%',
    borderTopLeftRadius: radius.lg + 8,
    borderTopRightRadius: radius.lg + 8,
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginTop: space.sm },
  titleRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: space.lg },
  title: { flex: 1, fontWeight: '700' },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    height: 48,
  },
  searchInput: { flex: 1, fontSize: 16 },
  tabs: {
    flexDirection: 'row',
    marginHorizontal: space.lg,
    marginTop: space.md,
    borderWidth: 1,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: space.sm + 2 },
  list: { marginTop: space.sm },
  section: {
    marginTop: space.md,
    marginBottom: space.xs,
    marginHorizontal: space.lg,
    letterSpacing: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
  },
  rowText: { flex: 1 },
  empty: { margin: space.lg },
});
