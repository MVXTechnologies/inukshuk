import type { Units } from '@core/format';
import { sourceAbbreviation } from '@core/catalog/exploreFormat';
import { indexInstallStatus } from '@core/catalog/installStatus';
import { catalogItemDistanceMeters } from '@core/catalog/nearest';
import { groupBySource, topoGroupTitle, topoMapsAlong } from '@core/trails/catalogAlong';
import {
  activitiesLabel,
  formatClimb,
  formatTrailLength,
  TRAIL_NETWORK_LABELS,
  trailPlaceLabel,
} from '@core/trails/format';
import { toBoundingBox } from '@core/trails/geometry';
import type { LongTrail, TrailCountry, TrailDetail } from '@core/trails/schema';
import { focusBbox, initialStageIndex, stageDisplayName } from '@core/trails/stages';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import { useCatalogStore } from '@state/catalogStore';
import { useLibraryStore } from '@state/libraryStore';
import { useLongTrailsStore } from '@state/longTrailsStore';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { InukshukLoader } from '@ui/components/InukshukLoader';
import { radius, space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Icon, ProgressBar, Snackbar, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CatalogItemRow } from '../CatalogItemRow';
import { ExploreStat } from '../explore/ExploreParts';
import { exploreItemHref } from '../explore/exploreRoutes';
import { useCatalogDownloadFlow } from '../explore/useCatalogDownloadFlow';
import { TRAIL_FOCUS_PADDING } from '@features/map/longTrail/trailFocus';

import { TrailRouteMap } from './TrailRouteMap';
import { TrailDownloadButton, useTrailDownload } from './useTrailDownload';
import { useTrailOrigin } from './useLongTrails';
import { useTrailClimb } from './useTrailClimb';
import { openExternalLink } from '@lib/openLink';

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
/** Let the map tab come up before framing the trail on it. */
const FOCUS_DELAY_MS = 450;
/** Topo sheets listed inline before "See all". */
const TOPO_ROWS = 12;

function hostOf(url: string): string {
  return /^https?:\/\/(?:www\.)?([^/?#]+)/i.exec(url)?.[1] ?? url;
}

function subtitle(
  trail: LongTrail | undefined,
  detail: TrailDetail | undefined,
  countries: Record<string, TrailCountry>,
): string {
  const acts = activitiesLabel(detail?.activities ?? trail?.activities ?? []);
  const from = detail?.from ?? trail?.from;
  const to = detail?.to ?? trail?.to;
  const place =
    from !== undefined && to !== undefined && from !== to
      ? `${from} → ${to}`
      : trail !== undefined
        ? trailPlaceLabel(trail, countries)
        : null;
  return [acts, place].filter((p) => p !== null && p !== '').join(' · ');
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
  const setFollowUser = useMapStore((s) => s.setFollowUser);
  const trail = useMemo(() => index?.trails.find((x) => x.id === id), [index, id]);

  useEffect(() => {
    if (status === 'idle') void load();
  }, [status, load]);
  useEffect(() => {
    if (index !== null && detail === undefined && detailStatus === undefined) void loadDetail(id);
  }, [index, detail, detailStatus, id, loadDetail]);

  const climb = useTrailClimb(detail ?? null);

  // Topo sheets along the trail: pull the catalog shards the trail reaches.
  const catalogStatus = useCatalogStore((s) => s.status);
  const catalogIndex = useCatalogStore((s) => s.index);
  const catalogItems = useCatalogStore((s) => s.items);
  const loadCatalog = useCatalogStore((s) => s.load);
  const ensureShardsInBounds = useCatalogStore((s) => s.ensureShardsInBounds);
  const catalogDownloads = useCatalogStore((s) => s.downloads);
  const maps = useLibraryStore((s) => s.maps);
  const [topoOpen, setTopoOpen] = useState<string | null>(null);
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
    // Stop following the GPS dot first, and frame the trail once the map tab
    // is up: a fit issued while the camera still tracks the user (or while
    // the tab is hidden) is overridden on device (emulator check, #467).
    setFollowUser(false);
    router.navigate('/');
    const bounds = toBoundingBox(focusBbox(d, focusStage ? stageIndex : null));
    setTimeout(() => setFocusBounds(bounds, TRAIL_FOCUS_PADDING), FOCUS_DELAY_MS);
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
          <Text style={[styles.subtitle, { color: t.inkMuted }]}>
            {subtitle(trail, detail, index?.countries ?? {})}
          </Text>
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
        </View>
        {detail !== undefined && detail.stages.length === 0 ? (
          <WholeTrailDownload detail={detail} onMessage={snack.show} />
        ) : (
          <Text style={[styles.note, { color: t.inkMuted }]}>
            Download a stage below for offline use — its map ≈3 km each side.
          </Text>
        )}

        {detail !== undefined && detail.stages.length > 0 && (
          <>
            <Text accessibilityRole="header" style={[styles.h2, { color: t.ink }]}>
              Stages
            </Text>
            {detail.stages.map((stage, i) => (
              <StageRow
                key={stage.id}
                detail={detail}
                index={i}
                climb={climbStage(i)}
                units={units}
                onShow={() => showOnMap(detail, i, true)}
                onMessage={snack.show}
              />
            ))}
          </>
        )}

        {topoGroups.length > 0 && (
          <>
            <Text accessibilityRole="header" style={[styles.h2, { color: t.ink }]}>
              Topo maps along this trail
            </Text>
            {topoGroups.map((group) => {
              const open = topoOpen === group.sourceId;
              const near = (item: (typeof group.items)[number]) =>
                origin !== null
                  ? catalogItemDistanceMeters(item, { latitude: origin[1], longitude: origin[0] })
                  : null;
              // The sheets nearest to you first: the ones you'd print for a start.
              const rowsShown = open
                ? [...group.items]
                    .sort((a, b) => (near(a) ?? 0) - (near(b) ?? 0))
                    .slice(0, TOPO_ROWS)
                : [];
              return (
                <View key={group.sourceId}>
                  <Pressable
                    onPress={() => setTopoOpen(open ? null : group.sourceId)}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: open }}
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
                      {open ? 'Hide' : 'See'}
                    </Text>
                  </Pressable>
                  {rowsShown.map((item) => (
                    <CatalogItemRow
                      key={item.id}
                      item={item}
                      source={catalogIndex?.sources.find((src) => src.id === item.sourceId)}
                      installStatus={installStatusById.get(item.id) ?? 'not-installed'}
                      downloading={item.id in catalogDownloads}
                      progress={catalogDownloads[item.id]}
                      expanded={false}
                      distanceMeters={near(item)}
                      units={units}
                      onToggleExpand={() => undefined}
                      onOpenDetails={() => router.push(exploreItemHref(item.id))}
                      onDownload={() => flow.requestDownload(item)}
                      onUpdate={() => flow.update(item)}
                      onOpen={() => flow.open(item)}
                      onCancel={() => flow.cancel(item)}
                    />
                  ))}
                  {open && group.items.length > TOPO_ROWS && (
                    <Text style={[styles.note, styles.topoMore, { color: t.inkMuted }]}>
                      The {TOPO_ROWS} nearest of {group.items.length} — the rest are in Explore.
                    </Text>
                  )}
                </View>
              );
            })}
          </>
        )}

        {rows.length > 0 && (
          <View style={styles.rows}>
            {rows.map((row) => (
              <View key={row.label} style={styles.row}>
                <Text style={[styles.rowLabel, { color: t.inkMuted }]}>{row.label}</Text>
                {row.url !== undefined ? (
                  <Pressable
                    onPress={() => void openExternalLink(row.url ?? '')}
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

/** One stage: number, name, length · climb · size, its download, and a tap shows it on the map. */
function StageRow({
  detail,
  index,
  climb,
  units,
  onShow,
  onMessage,
}: {
  detail: TrailDetail;
  index: number;
  climb: string | null;
  units: Units;
  onShow: () => void;
  onMessage: (message: string) => void;
}) {
  const t = useSchemeTokens();
  const stage = detail.stages[index];
  const download = useTrailDownload(detail, index, onMessage);
  if (stage === undefined) return null;
  const name = stageDisplayName(stage, detail.name);
  const meta = [
    stage.lengthKm > 0 ? formatTrailLength(stage.lengthKm, units) : null,
    climb !== null ? `${climb} climb` : null,
    download.status === 'done'
      ? `${download.sizeLabel} offline`
      : download.allowed
        ? download.sizeLabel
        : null,
  ]
    .filter((p): p is string => p !== null)
    .join(' · ');
  return (
    <View style={styles.stage}>
      <Pressable
        onPress={onShow}
        accessibilityRole="button"
        accessibilityLabel={`Stage ${index + 1}, ${name}${meta !== '' ? `, ${meta}` : ''}`}
        accessibilityHint="Shows this stage on the map"
        style={({ pressed }) => [styles.stageMain, pressed && styles.pressed]}
      >
        <View style={[styles.stageBadge, { backgroundColor: t.explore.trailBadge }]}>
          <Text style={[styles.stageBadgeText, { color: t.explore.trailBadgeInk }]}>
            {index + 1}
          </Text>
        </View>
        <View style={styles.stageText}>
          <Text numberOfLines={2} style={[styles.stageName, { color: t.ink }]}>
            {name}
          </Text>
          {meta !== '' && <Text style={[styles.stageMeta, { color: t.inkMuted }]}>{meta}</Text>}
        </View>
      </Pressable>
      {download.allowed && (
        <TrailDownloadButton download={download} label={`stage ${index + 1}, ${name}`} />
      )}
    </View>
  );
}

/** A trail without stages: one download when it is short, else a note. */
function WholeTrailDownload({
  detail,
  onMessage,
}: {
  detail: TrailDetail;
  onMessage: (message: string) => void;
}) {
  const t = useSchemeTokens();
  const download = useTrailDownload(detail, null, onMessage);
  if (!download.allowed) {
    return (
      <Text style={[styles.note, { color: t.inkMuted }]}>
        Too long to download in one go — download an area from the map instead.
      </Text>
    );
  }
  const busy = download.status === 'downloading';
  return (
    <>
      <Pressable
        onPress={download.start}
        disabled={download.status !== 'idle'}
        accessibilityRole="button"
        accessibilityLabel={download.status === 'done' ? 'Offline map downloaded' : 'Download'}
        accessibilityState={{ disabled: download.status !== 'idle' }}
        style={({ pressed }) => [
          styles.secondary,
          styles.wholeDownload,
          { borderColor: t.explore.accent },
          pressed && styles.pressed,
        ]}
      >
        <Icon
          source={download.status === 'done' ? 'check' : 'download'}
          size={20}
          color={t.explore.accent}
        />
        <Text style={[styles.secondaryText, { color: t.explore.accent }]}>
          {download.status === 'done' ? 'Downloaded' : busy ? 'Downloading…' : 'Download'}
        </Text>
      </Pressable>
      {busy && (
        <ProgressBar
          progress={download.fraction}
          color={t.explore.accent}
          style={styles.progress}
        />
      )}
      <Text style={[styles.note, { color: t.inkMuted }]}>
        {download.status === 'done'
          ? `Offline map downloaded · ${download.sizeLabel} · manage it in Settings`
          : `Offline map along the trail (≈3 km each side) · ${download.sizeLabel}`}
      </Text>
    </>
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
    gap: space.sm,
    paddingRight: space.lg,
  },
  stageMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 10,
    paddingLeft: space.lg,
  },
  wholeDownload: { flex: 0, marginTop: space.sm, marginHorizontal: space.lg },
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
  topoMore: { marginBottom: space.sm },
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
