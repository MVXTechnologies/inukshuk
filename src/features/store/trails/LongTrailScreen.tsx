import { sourceAbbreviation } from '@core/catalog/exploreFormat';
import { indexInstallStatus } from '@core/catalog/installStatus';
import { catalogItemDistanceMeters } from '@core/catalog/nearest';
import { formatByteSize } from '@core/storage/diskBudget';
import { groupBySource, topoGroupTitle, topoMapsAlong } from '@core/trails/catalogAlong';
import {
  activitiesLabel,
  formatClimb,
  formatTrailLength,
  TRAIL_NETWORK_LABELS,
} from '@core/trails/format';
import { toBoundingBox } from '@core/trails/geometry';
import type { LongTrail, TrailDetail } from '@core/trails/schema';
import { focusBbox, initialStageIndex } from '@core/trails/stages';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import { useCatalogStore } from '@state/catalogStore';
import { useLibraryStore } from '@state/libraryStore';
import { useLongTrailsStore } from '@state/longTrailsStore';
import { useMapStore } from '@state/mapStore';
import { useOfflineStore } from '@state/offlineStore';
import { useSettingsStore } from '@state/settingsStore';
import { InukshukLoader } from '@ui/components/InukshukLoader';
import { radius, space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Icon, ProgressBar, Snackbar, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CatalogItemRow } from '../CatalogItemRow';
import { ExploreStat } from '../explore/ExploreParts';
import { exploreItemHref } from '../explore/exploreRoutes';
import { useCatalogDownloadFlow } from '../explore/useCatalogDownloadFlow';
import { TrailRouteMap } from './TrailRouteMap';
import { downloadTrail, planTrailDownload, refusalMessage, trailPacks } from './trailDownload';
import { useTrailOrigin } from './useLongTrails';
import { useTrailClimb } from './useTrailClimb';

/**
 * One long-distance trail (#467, boards `Detail.dc.html` light and dark):
 * the route map, name and where it runs, Length / Stages / Climb, **Show on
 * map** and **Download** (the corridor offline map, with its size), the
 * stages, the topo sheets the trail crosses, and the OSM attribution.
 *
 * Opens from the index row at once (name, length, activities), then fills in
 * from the trail's detail document. Climb is computed from our DEM and only
 * shown once computed; a trail with no stages has no Stages section.
 */

const MAP_HEIGHT = 300;
/** Topo sheets listed inline before "See all". */
const TOPO_ROWS = 12;

function hostOf(url: string): string {
  return /^https?:\/\/(?:www\.)?([^/?#]+)/i.exec(url)?.[1] ?? url;
}

function subtitle(trail: LongTrail | undefined, detail: TrailDetail | undefined): string {
  const acts = activitiesLabel(detail?.activities ?? trail?.activities ?? []);
  const from = detail?.from ?? trail?.from;
  const to = detail?.to ?? trail?.to;
  const place = from !== undefined && to !== undefined && from !== to ? `${from} → ${to}` : null;
  return [acts, place ?? trail?.region]
    .filter((p) => p !== undefined && p !== null && p !== '')
    .join(' · ');
}

export function LongTrailScreen({ id }: { id: string }) {
  const t = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const units = useSettingsStore((s) => s.units);
  const origin = useTrailOrigin();
  const snack = useTimedSnackbar(4000);
  const flow = useCatalogDownloadFlow();

  const status = useLongTrailsStore((s) => s.status);
  const index = useLongTrailsStore((s) => s.index);
  const load = useLongTrailsStore((s) => s.load);
  const detail = useLongTrailsStore((s) => s.details[id]);
  const detailStatus = useLongTrailsStore((s) => s.detailStatus[id]);
  const loadDetail = useLongTrailsStore((s) => s.loadDetail);
  const show = useLongTrailsStore((s) => s.show);
  const setFocusBounds = useMapStore((s) => s.setFocusBounds);
  const trail = useMemo(() => index?.trails.find((x) => x.id === id), [index, id]);

  useEffect(() => {
    if (status === 'idle') void load();
  }, [status, load]);
  useEffect(() => {
    if (index !== null && detail === undefined && detailStatus === undefined) void loadDetail(id);
  }, [index, detail, detailStatus, id, loadDetail]);

  const climb = useTrailClimb(detail ?? null);
  const plan = useMemo(() => (detail ? planTrailDownload(detail) : null), [detail]);
  const regions = useOfflineStore((s) => s.regions);
  const packs = useMemo(() => trailPacks(regions, id), [regions, id]);
  const [downloading, setDownloading] = useState<number | null>(null);

  // Topo sheets along the trail: pull the catalog shards the trail reaches.
  const catalogStatus = useCatalogStore((s) => s.status);
  const catalogIndex = useCatalogStore((s) => s.index);
  const catalogItems = useCatalogStore((s) => s.items);
  const loadCatalog = useCatalogStore((s) => s.load);
  const ensureShardsInBounds = useCatalogStore((s) => s.ensureShardsInBounds);
  const catalogDownloads = useCatalogStore((s) => s.downloads);
  const maps = useLibraryStore((s) => s.maps);
  const [topoOpen, setTopoOpen] = useState(false);
  useEffect(() => {
    if (catalogStatus === 'idle') void loadCatalog();
  }, [catalogStatus, loadCatalog]);
  useEffect(() => {
    if (catalogStatus !== 'ready' || detail === undefined) return;
    void ensureShardsInBounds(detail.bbox, 'topo');
  }, [catalogStatus, detail, ensureShardsInBounds]);
  const topo = useMemo(
    () => (detail === undefined ? [] : topoMapsAlong(catalogItems, detail.geometry)),
    [catalogItems, detail],
  );
  const topoGroups = useMemo(
    () => groupBySource(topo, catalogIndex?.sources ?? []),
    [topo, catalogIndex],
  );
  const installStatusById = useMemo(() => indexInstallStatus(topo, maps), [topo, maps]);

  const lengthKm = detail?.lengthKm ?? trail?.lengthKm;
  const stageCount = detail?.stages.length ?? trail?.stageCount ?? 0;
  const climbStage = (i: number) =>
    climb.status === 'done' && climb.stagesM[i] != null
      ? formatClimb(climb.stagesM[i] ?? 0, units)
      : null;

  const showOnMap = (d: TrailDetail, stageIndex: number | null, focusStage: boolean) => {
    show(d, stageIndex);
    setFocusBounds(toBoundingBox(focusBbox(d, focusStage ? stageIndex : null)));
    router.navigate('/');
  };

  const startDownload = () => {
    if (detail === undefined || plan === null) return;
    setDownloading(0);
    void downloadTrail(detail, plan, setDownloading, (warning) => {
      if (warning !== null) snack.show(warning);
    })
      .then((refusal) => {
        if (refusal !== null) snack.show(refusalMessage(refusal));
        else snack.show('Offline map ready — it works without signal');
      })
      .catch((err: unknown) => snack.show(err instanceof Error ? err.message : String(err)))
      .finally(() => setDownloading(null));
  };

  const name = detail?.name ?? trail?.name;
  if (name === undefined) {
    return (
      <View style={[styles.fill, styles.center, { backgroundColor: t.background }]}>
        {status === 'unavailable' || (index !== null && trail === undefined) ? (
          <View style={styles.missing}>
            <Text variant="bodyMedium" style={[styles.centerText, { color: t.inkVariant }]}>
              This trail isn’t available right now.
            </Text>
            <Button mode="contained-tonal" onPress={() => router.back()}>
              Back
            </Button>
          </View>
        ) : (
          <InukshukLoader />
        )}
      </View>
    );
  }

  const stats = [
    lengthKm !== undefined ? { label: 'Length', value: formatTrailLength(lengthKm, units) } : null,
    stageCount > 0 ? { label: 'Stages', value: String(stageCount) } : null,
    climb.status === 'done'
      ? { label: 'Climb', value: formatClimb(climb.totalM, units) }
      : climb.status === 'computing' && detail !== undefined
        ? { label: 'Climb', value: '…' }
        : null,
  ].filter((s): s is { label: string; value: string } => s !== null);

  const downloaded = packs.length > 0 && packs.every((p) => p.complete);
  const packBytes = packs.reduce((sum, p) => sum + p.sizeBytes, 0);
  const downloadNote =
    downloading !== null
      ? `Downloading the offline map… ${Math.round(downloading * 100)} %`
      : downloaded
        ? `Offline map downloaded · ${formatByteSize(packBytes)} · manage it in Settings`
        : plan === null
          ? 'Offline map along the whole trail (≈3 km each side)'
          : plan.tooBig
            ? 'Too long to download in one go — download an area from the map instead'
            : `Offline map along the whole trail (≈3 km each side) · ${formatByteSize(plan.bytes)}`;

  const rows: { label: string; value: string; url?: string }[] = [
    ...(detail !== undefined || trail !== undefined
      ? [
          {
            label: 'Network',
            value: TRAIL_NETWORK_LABELS[detail?.network ?? trail?.network ?? 'o'],
          },
        ]
      : []),
    ...(detail?.operator !== undefined ? [{ label: 'Operator', value: detail.operator }] : []),
    ...(detail?.website !== undefined && /^https?:\/\//i.test(detail.website)
      ? [{ label: 'Website', value: hostOf(detail.website), url: detail.website }]
      : []),
  ];

  return (
    <View style={[styles.fill, { backgroundColor: t.background }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}>
        <View style={{ height: MAP_HEIGHT, backgroundColor: t.explore.trailThumb }}>
          {detail !== undefined ? (
            <TrailRouteMap detail={detail} height={MAP_HEIGHT} topInset={insets.top + 44} />
          ) : (
            <View style={[styles.fill, styles.center]}>
              {detailStatus === 'failed' ? (
                <Text style={[styles.centerText, { color: t.inkVariant }]}>
                  Couldn’t load the route. Check your connection.
                </Text>
              ) : (
                <InukshukLoader />
              )}
            </View>
          )}
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={2}
            style={[styles.back, { top: insets.top + space.sm, backgroundColor: t.surface }]}
          >
            <Icon source="arrow-left" size={22} color={t.ink} />
          </Pressable>
        </View>

        <View style={styles.head}>
          <Text accessibilityRole="header" style={[styles.title, { color: t.ink }]}>
            {name}
          </Text>
          <Text style={[styles.subtitle, { color: t.inkMuted }]}>{subtitle(trail, detail)}</Text>
        </View>

        {stats.length > 0 && (
          <View style={styles.stats}>
            {stats.map((s) => (
              <ExploreStat key={s.label} value={s.value} label={s.label} />
            ))}
          </View>
        )}

        <View style={styles.actions}>
          <Pressable
            onPress={() => {
              if (detail !== undefined) {
                showOnMap(detail, initialStageIndex(detail, origin), false);
              }
            }}
            disabled={detail === undefined}
            accessibilityRole="button"
            accessibilityState={{ disabled: detail === undefined }}
            style={({ pressed }) => [
              styles.primary,
              { backgroundColor: t.explore.accent },
              (pressed || detail === undefined) && styles.pressed,
            ]}
          >
            <Icon source="map-outline" size={20} color={t.background} />
            <Text style={[styles.primaryText, { color: t.background }]}>Show on map</Text>
          </Pressable>
          <Pressable
            onPress={startDownload}
            disabled={
              detail === undefined || downloading !== null || downloaded || plan?.tooBig === true
            }
            accessibilityRole="button"
            accessibilityLabel={downloaded ? 'Offline map downloaded' : 'Download'}
            accessibilityState={{
              disabled: detail === undefined || downloading !== null || downloaded,
            }}
            style={({ pressed }) => [
              styles.secondary,
              { borderColor: t.explore.accent },
              (pressed || detail === undefined || plan?.tooBig === true) && styles.pressed,
            ]}
          >
            <Icon source={downloaded ? 'check' : 'download'} size={20} color={t.explore.accent} />
            <Text style={[styles.secondaryText, { color: t.explore.accent }]}>
              {downloaded ? 'Downloaded' : 'Download'}
            </Text>
          </Pressable>
        </View>
        {downloading !== null && (
          <ProgressBar progress={downloading} color={t.explore.accent} style={styles.progress} />
        )}
        <Text style={[styles.note, { color: t.inkMuted }]}>{downloadNote}</Text>

        {detail !== undefined && detail.stages.length > 0 && (
          <>
            <Text accessibilityRole="header" style={[styles.h2, { color: t.ink }]}>
              Stages
            </Text>
            {detail.stages.map((stage, i) => {
              const climbText = climbStage(i);
              const meta = [
                stage.lengthKm > 0 ? formatTrailLength(stage.lengthKm, units) : null,
                climbText !== null ? `${climbText} climb` : null,
              ]
                .filter((p): p is string => p !== null)
                .join(' · ');
              return (
                <Pressable
                  key={stage.id}
                  onPress={() => showOnMap(detail, i, true)}
                  accessibilityRole="button"
                  accessibilityLabel={`Stage ${i + 1}, ${stage.name}${meta !== '' ? `, ${meta}` : ''}`}
                  accessibilityHint="Shows this stage on the map"
                  style={({ pressed }) => [styles.stage, pressed && styles.pressed]}
                >
                  <View style={[styles.stageBadge, { backgroundColor: t.explore.trailBadge }]}>
                    <Text style={[styles.stageBadgeText, { color: t.explore.trailBadgeInk }]}>
                      {i + 1}
                    </Text>
                  </View>
                  <View style={styles.stageText}>
                    <Text numberOfLines={2} style={[styles.stageName, { color: t.ink }]}>
                      {stage.name}
                    </Text>
                    {meta !== '' && (
                      <Text style={[styles.stageMeta, { color: t.inkMuted }]}>{meta}</Text>
                    )}
                  </View>
                  <Icon source="chevron-right" size={20} color={t.inkMuted} />
                </Pressable>
              );
            })}
          </>
        )}

        {topoGroups.length > 0 && (
          <>
            <Text accessibilityRole="header" style={[styles.h2, { color: t.ink }]}>
              Topo maps along this trail
            </Text>
            {topoGroups.map((group) => (
              <Pressable
                key={group.sourceId}
                onPress={() => setTopoOpen((o) => !o)}
                accessibilityRole="button"
                accessibilityState={{ expanded: topoOpen }}
                style={({ pressed }) => [
                  styles.topo,
                  { backgroundColor: t.surface, borderColor: t.outlineVariant },
                  pressed && styles.pressed,
                ]}
              >
                <View style={[styles.topoBadge, { backgroundColor: t.explore.placeholder }]}>
                  <Icon source="map-legend" size={24} color={t.explore.accent} />
                </View>
                <View style={styles.stageText}>
                  <Text style={[styles.stageName, { color: t.ink }]}>
                    {topoGroupTitle(group, sourceAbbreviation(group.sourceName))}
                  </Text>
                  <Text style={[styles.stageMeta, { color: t.inkMuted }]}>
                    {['Free', `from ${group.sourceName}`].join(' · ')}
                  </Text>
                </View>
                <Text style={[styles.see, { color: t.explore.accent }]}>
                  {topoOpen ? 'Hide' : 'See'}
                </Text>
              </Pressable>
            ))}
            {topoOpen &&
              topo.slice(0, TOPO_ROWS).map((item) => (
                <CatalogItemRow
                  key={item.id}
                  item={item}
                  source={catalogIndex?.sources.find((s) => s.id === item.sourceId)}
                  installStatus={installStatusById.get(item.id) ?? 'not-installed'}
                  downloading={item.id in catalogDownloads}
                  progress={catalogDownloads[item.id]}
                  expanded={false}
                  distanceMeters={
                    origin !== null
                      ? catalogItemDistanceMeters(item, {
                          latitude: origin[1],
                          longitude: origin[0],
                        })
                      : null
                  }
                  units={units}
                  onToggleExpand={() => undefined}
                  onOpenDetails={() => router.push(exploreItemHref(item.id))}
                  onDownload={() => flow.requestDownload(item)}
                  onUpdate={() => flow.update(item)}
                  onOpen={() => flow.open(item)}
                  onCancel={() => flow.cancel(item)}
                />
              ))}
          </>
        )}

        {rows.length > 0 && (
          <View style={styles.rows}>
            {rows.map((row) => (
              <View key={row.label} style={styles.row}>
                <Text style={[styles.rowLabel, { color: t.inkMuted }]}>{row.label}</Text>
                {row.url !== undefined ? (
                  <Pressable
                    onPress={() => void Linking.openURL(row.url ?? '')}
                    accessibilityRole="link"
                    accessibilityLabel={`Open ${row.value}`}
                    hitSlop={target.compactHitSlop}
                    style={styles.rowLink}
                  >
                    <Text style={[styles.rowValue, { color: t.explore.accent }]}>{row.value}</Text>
                  </Pressable>
                ) : (
                  <Text style={[styles.rowValue, { color: t.ink }]}>{row.value}</Text>
                )}
              </View>
            ))}
          </View>
        )}

        <Text style={[styles.attribution, { color: t.inkMuted }]}>
          Route from OpenStreetMap (© contributors, ODbL). Check the trail operator for closures,
          fees and reservations before you go.
        </Text>
      </ScrollView>
      {flow.overlays}
      <Snackbar visible={snack.message !== null} onDismiss={snack.dismiss} duration={Infinity}>
        {snack.message ?? ''}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  centerText: { textAlign: 'center', paddingHorizontal: 24 },
  missing: { alignItems: 'center', gap: 12 },
  pressed: { opacity: 0.7 },
  back: {
    position: 'absolute',
    left: space.md,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  head: { paddingTop: 18, paddingHorizontal: space.lg, gap: 6 },
  title: { fontSize: 26, lineHeight: 30, fontWeight: '800' },
  subtitle: { fontSize: 14, lineHeight: 19 },
  stats: { marginTop: space.lg, marginHorizontal: space.lg, flexDirection: 'row', gap: space.sm },
  actions: { marginTop: space.lg, marginHorizontal: space.lg, flexDirection: 'row', gap: space.sm },
  primary: {
    flex: 1,
    minHeight: 50,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  primaryText: { fontSize: 16, lineHeight: 21, fontWeight: '800' },
  secondary: {
    flex: 1,
    minHeight: 50,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  secondaryText: { fontSize: 16, lineHeight: 21, fontWeight: '800' },
  progress: { marginTop: space.md, marginHorizontal: space.lg, height: 6, borderRadius: 3 },
  note: { marginTop: space.sm, marginHorizontal: space.lg, fontSize: 13, lineHeight: 18 },
  h2: {
    marginTop: space.xl,
    marginBottom: space.sm,
    marginHorizontal: space.lg,
    fontSize: 18,
    lineHeight: 23,
    fontWeight: '800',
  },
  stage: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 10,
    paddingHorizontal: space.lg,
  },
  stageBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stageBadgeText: { fontSize: 14, lineHeight: 18, fontWeight: '800' },
  stageText: { flex: 1, minWidth: 0, gap: 2 },
  stageName: { fontSize: 15.5, lineHeight: 20, fontWeight: '700' },
  stageMeta: { fontSize: 13, lineHeight: 17 },
  topo: {
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  topoBadge: {
    width: 48,
    height: 48,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  see: { fontSize: 14, lineHeight: 18, fontWeight: '800' },
  rows: { marginTop: space.xl, marginHorizontal: space.lg, gap: 10 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space.md,
    minHeight: 24,
  },
  rowLabel: { fontSize: 14, lineHeight: 19 },
  rowValue: { flexShrink: 1, textAlign: 'right', fontSize: 14, lineHeight: 19, fontWeight: '700' },
  rowLink: { flexShrink: 1 },
  attribution: {
    marginTop: space.xl,
    marginHorizontal: space.lg,
    fontSize: 12,
    lineHeight: 18,
  },
});
