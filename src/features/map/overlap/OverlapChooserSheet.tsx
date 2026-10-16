import { categoryColor, findCategory } from '@core/library/categories';
import {
  overlapKey,
  overlapRowSubtitle,
  type OverlapHit,
  type OverlapRowInput,
} from '@core/map/overlapPick';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { mapColors } from '@ui/theme';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, IconButton, Text } from '@ui/paper';
import Svg, { Path } from 'react-native-svg';

import { useOverlapChooser } from './overlapChooser';
import { useScaledStyles } from '@ui/displayScale';

interface Props {
  onPickTrail: (trackId: string) => void;
  onPickArea: (areaId: string) => void;
  /** Floating above another bottom sheet (the recording panel): all corners rounded. */
  floating?: boolean;
  /** Another card took the slot: the list closes for good. */
  suppressed?: boolean;
}

/** Rows shown before the list scrolls. */
const VISIBLE_ROWS = 5;
const ROW_H = 56;

interface Row {
  key: string;
  hit: OverlapHit;
  name: string;
  subtitle: string;
  color: string;
}

/**
 * The chooser card, in the waypoint card's dock (a plain themed View, never
 * a Portal: the #108 soft-lock). Rows whose item has gone (deleted, hidden)
 * drop out; with none left it renders nothing.
 */
export function OverlapChooserSheet({
  onPickTrail,
  onPickArea,
  floating = false,
  suppressed = false,
}: Props) {
  const styles = useScaledStyles(stylesSheet);

  const hits = useOverlapChooser((s) => s.hits);
  const close = useOverlapChooser((s) => s.close);
  const tracks = useLibraryStore((s) => s.tracks);
  const areas = useLibraryStore((s) => s.areas);
  const custom = useLibraryStore((s) => s.customCategories);
  const units = useSettingsStore((s) => s.units);
  const t = useSchemeTokens();
  // "Oct 12" vs "Oct 12, 2025": the year this screen opened in is enough.
  const [now] = useState(() => Date.now());

  const rows = useMemo((): Row[] => {
    if (hits === null) return [];
    const out: Row[] = [];
    for (const hit of hits) {
      let input: OverlapRowInput;
      let name: string;
      let color: string;
      if (hit.kind === 'trail') {
        const tr = tracks.find((x) => x.id === hit.id);
        if (!tr) continue;
        name = tr.name;
        color = categoryColor(tr.category, custom) ?? mapColors.trackOverlay;
        input = {
          kind: 'trail',
          typeName: findCategory(tr.category, custom)?.name ?? null,
          planned: tr.plan !== undefined,
          distanceM: tr.stats.distanceM,
          // An untimed trail (a route, a navigation GPX) has no outing date:
          // its startedAt is when it was imported or drawn.
          startedAt: tr.stats.durationS > 0 ? tr.startedAt : 0,
        };
      } else {
        const area = areas.find((x) => x.id === hit.id);
        if (!area) continue;
        name = area.name;
        color = area.color;
        input = { kind: 'area', sizeM2: hit.sizeM2 };
      }
      out.push({
        key: overlapKey(hit),
        hit,
        name,
        color,
        subtitle: overlapRowSubtitle(input, units, now),
      });
    }
    return out;
  }, [hits, tracks, areas, custom, units, now]);

  useEffect(() => {
    if (suppressed) close();
  }, [suppressed, close]);
  if (suppressed || rows.length < 2) return null;
  return (
    <View
      style={[
        styles.card,
        floating && styles.floating,
        { backgroundColor: t.elevation.level2, shadowColor: palette.shadow },
      ]}
      testID="overlap-chooser"
    >
      <View style={styles.header}>
        <Icon source="layers-triple-outline" size={22} color={t.inkVariant} />
        <Text
          variant="titleMedium"
          style={[styles.title, { color: t.ink }]}
          accessibilityRole="header"
        >
          {`${rows.length} here`}
        </Text>
        <IconButton
          icon="close"
          size={20}
          onPress={close}
          accessibilityLabel="Close the list"
          testID="overlap-chooser-close"
        />
      </View>
      <ScrollView style={{ maxHeight: VISIBLE_ROWS * ROW_H }} bounces={false}>
        {rows.map((row) => (
          <Pressable
            key={row.key}
            style={({ pressed }) => [
              styles.row,
              { borderTopColor: t.outlineVariant },
              pressed && { backgroundColor: t.elevation.level4 },
            ]}
            onPress={() => {
              close();
              if (row.hit.kind === 'trail') onPickTrail(row.hit.id);
              else onPickArea(row.hit.id);
            }}
            accessibilityRole="button"
            accessibilityLabel={`${row.name}, ${row.subtitle}`}
            testID={`overlap-row-${row.key}`}
          >
            <Swatch kind={row.hit.kind} color={row.color} />
            <View style={styles.text}>
              <Text variant="bodyLarge" style={{ color: t.ink }} numberOfLines={1}>
                {row.name}
              </Text>
              <Text variant="bodySmall" style={{ color: t.inkMuted }} numberOfLines={1}>
                {row.subtitle}
              </Text>
            </View>
            <Icon source="chevron-right" size={22} color={t.inkMuted} />
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

/** A trail's stroke or an area's outline, in the item's own colour. */
function Swatch({ kind, color }: { kind: OverlapHit['kind']; color: string }) {
  const styles = useScaledStyles(stylesSheet);

  return (
    <View style={styles.swatch} testID={`overlap-swatch-${kind}`}>
      <Svg width={28} height={28} viewBox="0 0 28 28">
        {kind === 'trail' ? (
          <Path
            d="M3 22 C10 18 14 10 25 6"
            stroke={color}
            strokeWidth={4}
            strokeLinecap="round"
            fill="none"
          />
        ) : (
          <Path
            d="M5 8 L20 4 L25 15 L18 24 L6 22Z"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            fill={color}
            fillOpacity={0.2}
          />
        )}
      </Svg>
    </View>
  );
}

const stylesSheet = StyleSheet.create({
  card: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 4,
    paddingBottom: 8,
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -2 },
    elevation: 8,
  },
  floating: { borderRadius: 16 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 16, paddingRight: 4 },
  title: { flex: 1, paddingVertical: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: ROW_H,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  swatch: { width: 28, height: 28 },
  text: { flex: 1 },
});
