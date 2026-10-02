import { FIX_THE_MAP_URL, type MapCreditLine } from '@core/map/mapCredits';
import { useChromeOutline } from '@ui/useChromeOutline';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { MapSheet, SectionTitle, SheetHeader } from './mapSheet';

/**
 * The map's credits (2.1.1, owner request): a small ⓘ button to the LEFT of
 * the scale bar, opening a compact sheet of every data source on screen.
 *
 * It replaces the grey caption ("© OpenStreetMap · Protomaps") that #476 put
 * there. OpenStreetMap's attribution guideline accepts an "i" control on the
 * map that reveals the credit on tap, as long as it is on the map view
 * itself; the sheet also carries the routing engine's credit and the
 * "Report a map error" link the draw panel used to show. The full roll stays
 * in Settings › System info, linked from the sheet.
 */
export function MapCreditsButton({ onPress }: { onPress: () => void }) {
  const t = useSchemeTokens();
  const outline = useChromeOutline();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Map data credits"
      accessibilityHint="Lists the sources of the map on screen"
      hitSlop={10}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: t.map.chip },
        outline,
        pressed && styles.pressed,
      ]}
      testID="map-credits-button"
    >
      <Icon source="information-variant" size={16} color={t.map.chipInkMuted} />
    </Pressable>
  );
}

/**
 * The credits sheet: a plain themed card over the map (never a Portal or a
 * Dialog), with a full-screen backdrop that closes it on any tap.
 */
export function MapCreditsSheet({
  lines,
  bottom,
  onClose,
}: {
  lines: readonly MapCreditLine[];
  /** Distance from the map's bottom edge to the sheet's. */
  bottom: number;
  onClose: () => void;
}) {
  const t = useSchemeTokens();
  const router = useRouter();
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" testID="map-credits">
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityLabel="Close map credits"
        testID="map-credits-backdrop"
      />
      <View style={[styles.dock, { bottom }]} pointerEvents="box-none">
        <MapSheet accessibilityLabel="Map data credits">
          <SheetHeader title="Map data" closeLabel="Close map credits" onClose={onClose} />
          <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
            {lines.map((line) => (
              <View key={line.id} testID={`map-credit-${line.id}`}>
                <SectionTitle>{line.label}</SectionTitle>
                <Text style={[styles.credit, { color: t.ink }]}>{line.credit}</Text>
                {line.link !== undefined && (
                  <CreditLink label={line.link.label} url={line.link.url} />
                )}
              </View>
            ))}
            <View style={[styles.footer, { borderTopColor: t.outlineVariant }]}>
              <Pressable
                onPress={() => void Linking.openURL(FIX_THE_MAP_URL)}
                accessibilityRole="link"
                accessibilityLabel="Report a map error"
                style={styles.footerRow}
                testID="map-credits-report"
              >
                <Icon source="flag-outline" size={18} color={t.inkVariant} />
                <Text style={[styles.footerText, { color: t.ink }]}>Report a map error</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  onClose();
                  router.push('/settings');
                }}
                accessibilityRole="link"
                accessibilityLabel="All data credits, in Settings"
                style={styles.footerRow}
              >
                <Icon source="format-list-bulleted" size={18} color={t.inkVariant} />
                <Text style={[styles.footerText, { color: t.ink }]}>All data credits</Text>
              </Pressable>
            </View>
          </ScrollView>
        </MapSheet>
      </View>
    </View>
  );
}

function CreditLink({ label, url }: { label: string; url: string }) {
  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={() => void Linking.openURL(url)}
      accessibilityRole="link"
      accessibilityLabel={label}
      hitSlop={6}
      style={styles.linkHit}
    >
      <Text style={[styles.link, { color: t.inkVariant }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Small on the map (the scale bar's height), with a 44-dp hit area via hitSlop.
  button: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
  dock: { position: 'absolute', left: 16, right: 16, alignItems: 'flex-start' },
  scroll: { maxHeight: 360 },
  body: { paddingBottom: 4 },
  credit: { fontSize: 14, lineHeight: 19, marginHorizontal: 16 },
  linkHit: { alignSelf: 'flex-start', marginHorizontal: 16, marginTop: 2 },
  link: { fontSize: 13, lineHeight: 18, textDecorationLine: 'underline', fontWeight: '600' },
  footer: {
    marginTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 4,
    paddingHorizontal: 8,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 8,
  },
  footerText: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
});
