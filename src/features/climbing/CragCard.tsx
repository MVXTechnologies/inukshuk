import {
  accessView,
  approachLabel,
  attributionLine,
  cragGradeRange,
  cragRowMeta,
  routesLabel,
  styleNames,
} from '@core/climbing/card';
import { downloadable, type CragSummary } from '@core/climbing/crag';
import { updateAvailable } from '@core/climbing/saved';
import { formatBytes } from '@core/format';
import type { CragDownload } from '@state/climbingStore';
import { useClimbingStore } from '@state/climbingStore';
import { space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Icon, Text } from 'react-native-paper';

import { AccessPill, BandBar, CragBadge, Pill, useGradeSystem } from './ClimbingParts';

/** One crag in the Explore sheet's list (mockup 01). */
export function CragRow({
  crag,
  distance,
  onPress,
}: {
  crag: CragSummary;
  distance: string | null;
  onPress: () => void;
}) {
  const t = useSchemeTokens();
  const system = useGradeSystem();
  const saved = useClimbingStore((s) => s.saved.some((c) => c.uid === crag.uid));
  const closed = !downloadable(crag.access);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${crag.name}, ${cragRowMeta(crag, system, distance)}`}
      style={styles.row}
      testID={`crag-row-${crag.uid}`}
    >
      <CragBadge size={44} saved={saved} closed={closed} />
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={[styles.rowTitle, { color: t.ink }]}>
          {crag.name}
        </Text>
        <Text numberOfLines={1} style={[styles.rowMeta, { color: t.inkMuted }]}>
          {closed
            ? `Access closed · ${cragRowMeta(crag, system, distance)}`
            : cragRowMeta(crag, system, distance)}
        </Text>
        <BandBar bands={crag.bands} system={system} legend={false} height={4} />
      </View>
    </Pressable>
  );
}

/**
 * The crag card in the Explore sheet (mockup 02): what, where, how hard, and
 * Download · size / Topo / Close. Works from the tile summary alone (offline
 * wherever the tiles are cached).
 */
export function CragCard({
  crag,
  distance,
  mapBytes,
  download,
  onDownload,
  onTopo,
  onClose,
}: {
  crag: CragSummary;
  distance: string | null;
  /** The crag map's estimated size, for "Download · 6.4 MB". */
  mapBytes: number | null;
  download: CragDownload | undefined;
  onDownload: () => void;
  onTopo: () => void;
  onClose: () => void;
}) {
  const t = useSchemeTokens();
  const system = useGradeSystem();
  const saved = useClimbingStore((s) => s.saved.find((x) => x.uid === crag.uid));
  const access = accessView(crag.access, crag);
  const closed = !downloadable(crag.access);
  const range = cragGradeRange(crag.ranges, crag.styles, system);
  const where = [distance, approachLabel(crag.approachMin)].filter(Boolean).join(' · ');
  const update = saved !== undefined && updateAvailable(saved, crag.version);
  const primary = closed
    ? null
    : download
      ? {
          label:
            download.phase === 'map' && download.expectedBytes > 0
              ? `Downloading · ${Math.round(download.pct)} %`
              : 'Downloading…',
          icon: null,
          busy: true,
        }
      : saved
        ? update
          ? { label: 'Update topo', icon: 'update', busy: false }
          : { label: 'Open topo', icon: 'format-list-numbered', busy: false }
        : {
            label: `Download${mapBytes !== null ? ` · ${formatBytes(mapBytes)}` : ''}`,
            icon: 'download',
            busy: false,
          };
  return (
    <View style={styles.card} testID="crag-card">
      <View style={styles.head}>
        <CragBadge size={72} saved={saved !== undefined} closed={closed} />
        <View style={styles.rowText}>
          <Text
            numberOfLines={2}
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
          {where !== '' && (
            <Text numberOfLines={2} style={[styles.where, { color: t.explore.accent }]}>
              {where}
            </Text>
          )}
        </View>
      </View>
      <View style={styles.chips}>
        {saved !== undefined && <Pill label="Saved offline" tone="saved" icon="check-circle" />}
        <Pill label={crag.routes > 0 ? routesLabel(crag.routes) : 'No route list'} tone="crag" />
        {range !== null && <Pill label={range} />}
      </View>
      <BandBar bands={crag.bands} system={system} />
      <Text style={[styles.meta, { color: t.inkVariant }]}>
        {[styleNames(crag.styles), crag.sectors > 1 ? `${crag.sectors} sectors` : null]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      <AccessPill access={access} />
      <View style={styles.actions}>
        {primary !== null && (
          <Pressable
            onPress={primary.busy ? undefined : update || !saved ? onDownload : onTopo}
            disabled={primary.busy}
            accessibilityRole="button"
            accessibilityState={{ busy: primary.busy }}
            style={[styles.primary, { backgroundColor: t.library.chipOn }]}
            testID="crag-card-primary"
          >
            {primary.busy ? (
              <ActivityIndicator size={16} color={t.library.chipOnInk} />
            ) : (
              primary.icon !== null && (
                <Icon source={primary.icon} size={20} color={t.library.chipOnInk} />
              )
            )}
            <Text numberOfLines={1} style={[styles.primaryText, { color: t.library.chipOnInk }]}>
              {primary.label}
            </Text>
          </Pressable>
        )}
        {(primary === null || !saved || update) && (
          <Pressable
            onPress={onTopo}
            accessibilityRole="button"
            accessibilityLabel="Topo"
            style={[
              styles.secondary,
              { borderColor: t.outlineVariant },
              primary === null && styles.grow,
            ]}
            testID="crag-card-topo"
          >
            <Icon source="format-list-numbered" size={20} color={t.ink} />
            <Text style={[styles.primaryText, { color: t.ink }]}>Topo</Text>
          </Pressable>
        )}
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={[styles.round, { borderColor: t.outlineVariant }]}
        >
          <Icon source="close" size={20} color={t.ink} />
        </Pressable>
      </View>
      <Text style={[styles.credit, { color: t.inkMuted }]}>{attributionLine(crag.sources)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 6,
  },
  rowText: { flex: 1, minWidth: 0, gap: 3 },
  rowTitle: { fontSize: 16, lineHeight: 21, fontWeight: '800' },
  rowMeta: { fontSize: 13, lineHeight: 18 },
  card: { gap: space.md },
  head: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  title: { fontSize: 20, lineHeight: 25, fontWeight: '800' },
  region: { fontSize: 15, lineHeight: 20 },
  where: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  meta: { fontSize: 15, lineHeight: 20 },
  actions: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  primary: {
    flex: 1,
    minHeight: target.min,
    borderRadius: target.min / 2,
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.md,
  },
  primaryText: { fontSize: 16, lineHeight: 20, fontWeight: '800' },
  secondary: {
    minHeight: target.min,
    paddingHorizontal: space.lg,
    borderRadius: target.min / 2,
    borderWidth: 1,
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grow: { flex: 1 },
  round: {
    width: target.min,
    height: target.min,
    borderRadius: target.min / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  credit: { fontSize: 12, lineHeight: 16, textAlign: 'center' },
});
