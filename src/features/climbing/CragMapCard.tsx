import {
  accessView,
  approachLabel,
  attributionLine,
  cragGradeRange,
  routesLabel,
  sectorList,
  styleLine,
  styleNames,
} from '@core/climbing/card';
import type { CragSummary } from '@core/climbing/crag';
import { approachText, type CragDetail } from '@core/climbing/detail';
import { space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { BandBar, CragBadge, Pill, useGradeSystem } from './ClimbingParts';

/**
 * A crag tapped on the main map (mockup 05), in the WaypointViewerCard idiom
 * — a plain bottom card, never a Portal dialog: Saved offline, routes,
 * grades, sectors, approach, style, access; Open topo, Navigate, Share.
 */
export function CragMapCard({
  crag,
  detail,
  saved,
  floating = false,
  onOpenTopo,
  onNavigate,
  onShare,
  onClose,
}: {
  crag: CragSummary;
  /** The saved topo, when the crag is downloaded (sectors, approach, style counts). */
  detail: CragDetail | null;
  saved: boolean;
  floating?: boolean;
  onOpenTopo: () => void;
  onNavigate: () => void;
  onShare: () => void;
  onClose: () => void;
}) {
  const t = useSchemeTokens();
  const system = useGradeSystem();
  const range = cragGradeRange(crag.ranges, crag.styles, system);
  const access = accessView(crag.access, detail ?? crag, detail?.access);
  const approach = [
    approachLabel(detail?.approach?.min ?? crag.approachMin),
    approachText(detail?.approach, 'en')?.text.split('\n')[0] ?? null,
  ]
    .filter(Boolean)
    .join(' · ');
  const rows: [string, string][] = [];
  if (detail && detail.sectors.length > 1) {
    rows.push(['Sectors', sectorList(detail.sectors.map((s) => s.name))]);
  } else if (!detail && crag.sectors > 1) {
    rows.push(['Sectors', `${crag.sectors} sectors`]);
  }
  if (approach !== '') rows.push(['Approach', approach]);
  const style = detail ? styleLine(detail.styles) : styleNames(crag.styles);
  if (style !== '') rows.push(['Style', style]);
  rows.push(['Access', access.label]);
  return (
    <View
      style={[styles.card, floating && styles.floating, { backgroundColor: t.surface }]}
      testID="crag-map-card"
    >
      <View style={styles.header}>
        <CragBadge size={44} saved={saved} closed={access.tone === 'danger'} />
        <View style={styles.flex}>
          <Text
            numberOfLines={1}
            style={[styles.title, { color: t.ink }]}
            accessibilityRole="header"
          >
            {crag.name}
          </Text>
          {crag.region !== null && (
            <Text numberOfLines={1} style={[styles.region, { color: t.inkVariant }]}>
              {crag.region}
            </Text>
          )}
        </View>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={8}
          style={styles.close}
        >
          <Icon source="close" size={24} color={t.ink} />
        </Pressable>
      </View>
      <View style={styles.chips}>
        {saved && <Pill label="Saved offline" tone="saved" icon="check-circle" />}
        {crag.routes > 0 && <Pill label={routesLabel(crag.routes)} tone="crag" />}
        {range !== null && <Pill label={range} />}
      </View>
      <BandBar bands={crag.bands} system={system} legend={false} height={6} />
      <View style={styles.rows}>
        {rows.map(([label, value]) => (
          <View key={label} style={styles.row}>
            <Text style={[styles.label, { color: t.inkVariant }]}>{label.toUpperCase()}</Text>
            <Text style={[styles.value, { color: t.ink }]} numberOfLines={3}>
              {value}
            </Text>
          </View>
        ))}
      </View>
      <View style={styles.actions}>
        <Pressable
          onPress={onOpenTopo}
          accessibilityRole="button"
          style={[styles.primary, { backgroundColor: t.library.chipOn }]}
          testID="crag-map-card-topo"
        >
          <Icon source="format-list-numbered" size={20} color={t.library.chipOnInk} />
          <Text style={[styles.buttonText, { color: t.library.chipOnInk }]}>Open topo</Text>
        </Pressable>
        <Pressable
          onPress={onNavigate}
          accessibilityRole="button"
          style={[styles.secondary, { borderColor: t.outlineVariant }]}
        >
          <Icon source="navigation-variant-outline" size={20} color={t.ink} />
          <Text style={[styles.buttonText, { color: t.ink }]}>Navigate</Text>
        </Pressable>
        <Pressable
          onPress={onShare}
          accessibilityRole="button"
          accessibilityLabel="Share"
          style={[styles.round, { borderColor: t.outlineVariant }]}
        >
          <Icon source="share-variant" size={20} color={t.ink} />
        </Pressable>
      </View>
      <Text style={[styles.credit, { color: t.inkMuted }]} numberOfLines={2}>
        {attributionLine(crag.sources)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  floating: { borderRadius: 16 },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  flex: { flex: 1, minWidth: 0 },
  title: { fontSize: 20, lineHeight: 25, fontWeight: '800' },
  region: { fontSize: 14, lineHeight: 19 },
  close: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  rows: { gap: 6 },
  row: { flexDirection: 'row', gap: space.md },
  label: { width: 96, fontSize: 12, lineHeight: 18, fontWeight: '800', letterSpacing: 0.8 },
  value: { flex: 1, fontSize: 15, lineHeight: 20 },
  actions: { flexDirection: 'row', gap: space.sm, alignItems: 'center', marginTop: space.xs },
  primary: {
    flex: 1,
    minHeight: target.min,
    borderRadius: target.min / 2,
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondary: {
    minHeight: target.min,
    paddingHorizontal: space.md,
    borderRadius: target.min / 2,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  round: {
    width: target.min,
    height: target.min,
    borderRadius: target.min / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 15, lineHeight: 20, fontWeight: '800' },
  credit: { fontSize: 12, lineHeight: 16, textAlign: 'center' },
});
