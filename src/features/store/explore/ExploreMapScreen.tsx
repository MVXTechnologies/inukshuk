import { VECTOR_BASEMAP_ENABLED } from '@core/features/flags';
import {
  categoryForKind,
  filterExploreItems,
  type ExploreFilter,
} from '@core/catalog/exploreFacets';
import {
  boundsCenter,
  clusterIdOf,
  clusterTapZoom,
  EXPLORE_MAP_START_ZOOM,
  EXPLORE_SHEET_FRACTION,
  footprintFeature,
  normalizeBounds,
  pendingShardCountInBounds,
  type ExploreBounds,
} from '@core/catalog/exploreMap';
import {
  countPlaceFacets,
  cullPoints,
  cullWindow,
  exploreEmptyState,
  explorePointCollection,
  explorePoints,
  inAreaLabel,
  nearestPointsView,
  placePoints,
  pointDistanceMeters,
  pointsInSheetView,
  sortPointsByDistance,
  tappedPointOf,
  type ExplorePoint,
  type ExplorePointKind,
  type PlacePoint,
} from '@core/catalog/explorePoints';
import {
  EXPLORE_CLUSTER_COUNT_LAYOUT,
  EXPLORE_CLUSTER_FILTER,
  EXPLORE_POINT_FILTER,
  exploreClusterPaint,
  explorePointPaint,
} from '@core/catalog/explorePointStyle';
import { installStatusFor } from '@core/catalog/installStatus';
import { formatDistanceAway } from '@core/catalog/nearbySections';
import { bboxCenter } from '@core/catalog/nearest';
import { placeActivities } from '@core/catalog/collections';
import type { CatalogItem } from '@core/catalog/schema';
import { CATALOG_ACTIVITY_LABELS, CATALOG_KIND_LABELS } from '@core/catalog/taxonomy';
import { STONE_FONTS_ATKINSON, STONE_FONTS_NOTO } from '@core/map/stoneStyle';
import { formatByteSize } from '@core/storage/diskBudget';
import { vectorBasemapOption } from '@data/basemapTiles';
import { buildOsmStyle } from '@features/map/mapStyle';
import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  type GeoJSONSourceRef,
  Layer,
  Map,
  type MapRef,
} from '@maplibre/maplibre-react-native';
import { useCatalogStore } from '@state/catalogStore';
import { useExploreHandoffStore } from '@state/exploreHandoffStore';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { palette, space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Keyboard,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { ActivityIndicator, Icon, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ExploreFilterBar } from './ExploreFilterBar';
import { MapPreview } from './ExploreParts';
import { exploreItemHref, exploreListHref } from './exploreRoutes';
import { itemFacets } from './facetsAdapter';
import { useCatalogDownloadFlow } from './useCatalogDownloadFlow';
import { useLinkOutCollections } from './useLinkOutCollections';
import { openExternalLink } from '@lib/openLink';

/**
 * Explore on a map (#447, board `MapView.dc.html`): the loaded catalog AND the
 * link-out collections' places (Sépaq parks and reserves, zecs) as clustered
 * points on the app's own base style, a back arrow / filter field /
 * list toggle row and the filter chips (Type, Activity, Terrain, Source) on
 * top, "Search
 * this area" once the view reaches shards not loaded yet, and a bottom sheet
 * listing what is in view — or, after a point tap, that point's card: a map
 * with Download / Details and its footprint drawn as a rectangle, or a place
 * with the link out to its publisher's site. Tapping a cluster zooms in.
 *
 * Checking an activity ("Paddling", "Hunting") narrows BOTH kinds of point to
 * it and, when none is on screen, re-frames on the nearest ones; an activity
 * with nothing at all says so (`exploreEmptyState`) instead of leaving a
 * blank map. Points are styled per kind (`explorePointPaint`).
 *
 * Staying fast: the source clusters natively, and past
 * `EXPLORE_CULL_THRESHOLD` points it is fed only those around the view
 * (`cullWindow`, with hysteresis so a pan does not re-cluster).
 *
 * Nothing here ever loads the whole catalog: "Search this area" pulls the
 * shards reaching into the view nearest its centre, under the store's usual
 * count and byte budgets (`catalogStore.ensureShardsInBounds`), and the button
 * stays up while the view still has unloaded shards.
 *
 * The sheet is a plain themed View, not a paper Surface: an absolutely
 * positioned Surface collapses its flex column on iOS. In list mode it has a
 * fixed height (`EXPLORE_SHEET_FRACTION` of the screen) whatever it lists —
 * "in this area" is trimmed by that height, so a content-sized sheet made the
 * count feed back into itself and flicker (#459).
 */

const SOURCE_ID = 'explore-catalog';
/** Rows the sheet lists — enough to scan, never a 5 000-row FlatList in a sheet. */
const SHEET_ROWS = 50;
/** Share of the screen the list sheet covers (fixed: see EXPLORE_SHEET_FRACTION). */
const SHEET_FRACTION = EXPLORE_SHEET_FRACTION;

function hostOf(url: string): string {
  const match = /^https?:\/\/(?:www\.)?([^/?#]+)/i.exec(url);
  return match?.[1] ?? url;
}

/** "ZEC · Réseau Zec · hunting, fishing" — what a place is, whose, and for what. */
function placeMeta({ place, collection }: PlacePoint): string {
  const activities = placeActivities(place)
    .map((a) => CATALOG_ACTIVITY_LABELS[a].toLowerCase())
    .join(', ');
  return [place.type, collection.publisher, activities].filter((p) => p !== '').join(' · ');
}

function itemMeta(item: CatalogItem, sourceName: string | undefined): string {
  const kind = itemFacets(item).kind;
  return [
    kind !== null ? CATALOG_KIND_LABELS[kind] : undefined,
    sourceName,
    item.sizeBytes !== undefined ? formatByteSize(item.sizeBytes) : undefined,
    'Free',
  ]
    .filter((p): p is string => p !== undefined && p !== '')
    .join(' · ');
}

export function ExploreMapScreen({
  initialFilter,
  fromList = false,
}: {
  initialFilter: ExploreFilter;
  /** Pushed over a filtered list: back returns there, with this filter (#474). */
  fromList?: boolean;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { height: screenHeight } = useWindowDimensions();

  const status = useCatalogStore((s) => s.status);
  const index = useCatalogStore((s) => s.index);
  const items = useCatalogStore((s) => s.items);
  const loadingShards = useCatalogStore((s) => s.loadingShards);
  const load = useCatalogStore((s) => s.load);
  const ensureShardsInBounds = useCatalogStore((s) => s.ensureShardsInBounds);
  const unavailableShardIds = useCatalogStore((s) => s.unavailableShardIds);
  const position = useSettingsStore((s) => s.lastKnownPosition);
  const units = useSettingsStore((s) => s.units);
  const libraryMaps = useLibraryStore((s) => s.maps);
  const downloads = useCatalogStore((s) => s.downloads);
  const { collections } = useLinkOutCollections();
  const flow = useCatalogDownloadFlow();
  const tileUrl = useSettingsStore((s) => s.tileUrl);
  const showHillshade = useSettingsStore((s) => s.showHillshade);
  const contours = useSettingsStore((s) => s.terrainContours);

  const [filter, setFilter] = useState<ExploreFilter>(initialFilter);
  const [text, setText] = useState('');

  // Keep the list underneath in step: whichever way the user goes back (the
  // arrow, the list toggle, Android's back), it shows this filter.
  const handBack = useExploreHandoffStore((s) => s.handBack);
  useEffect(() => {
    if (fromList) handBack(filter);
  }, [fromList, filter, handBack]);
  const goBack = () => router.back();
  const showList = () => (fromList ? router.back() : router.replace(exploreListHref(filter)));
  const [bounds, setBounds] = useState<ExploreBounds | null>(null);
  const [zoom, setZoom] = useState(EXPLORE_MAP_START_ZOOM);
  const [selectedRef, setSelectedRef] = useState<{ kind: ExplorePointKind; key: string } | null>(
    null,
  );
  // The box of points the source is fed once there are thousands (cullWindow).
  const [cullBox, setCullBox] = useState<ExploreBounds | null>(null);
  const autoSearched = useRef(false);
  const framed = useRef(false);
  // The native map ignores camera commands until it has loaded.
  const [mapReady, setMapReady] = useState(false);

  const mapRef = useRef<MapRef>(null);
  const cameraRef = useRef<CameraRef>(null);
  const sourceRef = useRef<GeoJSONSourceRef>(null);

  useEffect(() => {
    if (status === 'idle') void load();
  }, [status, load]);

  // The app's own base map (the Stone & Paper vector style when enabled).
  const vector = useMemo(
    () => (VECTOR_BASEMAP_ENABLED ? vectorBasemapOption(theme.dark, contours) : null),
    [theme.dark, contours],
  );
  const style = useMemo(
    () => buildOsmStyle(tileUrl, 'map', showHillshade, vector ? { vectorBasemap: vector } : {}),
    [tileUrl, showHillshade, vector],
  );
  // Cluster counts need glyphs: only the vector style declares them.
  const countFont =
    vector === null ? null : vector.glyphs ? STONE_FONTS_ATKINSON.bold : STONE_FONTS_NOTO.bold;

  const category = categoryForKind(filter.kind);
  const fullFilter = useMemo(() => ({ ...filter, text }), [filter, text]);
  const filtered = useMemo(
    () => filterExploreItems(items, fullFilter, itemFacets),
    [items, fullFilter],
  );
  // Every point for this filter: catalog sheets and link-out places alike.
  const allPoints = useMemo(
    () => explorePoints(filtered, collections, fullFilter),
    [filtered, collections, fullFilter],
  );
  const points = useMemo(
    () => explorePointCollection(cullPoints(allPoints, cullBox)),
    [allPoints, cullBox],
  );
  const placeCounts = useMemo(() => countPlaceFacets(collections), [collections]);
  // Only what the sheet leaves visible counts as "in this area" — the maps
  // under the sheet are not on screen (emulator check, 2026-09-29). The trim is
  // the sheet's FIXED share, never its measured height: that height followed
  // this very list and looped it into a flicker (#459).
  const inView = useMemo(
    () => (bounds === null ? [] : pointsInSheetView(allPoints, bounds, SHEET_FRACTION)),
    [allPoints, bounds],
  );

  const frame = useCallback(
    (view: ExploreBounds, duration: number) => {
      cameraRef.current?.fitBounds(view, {
        padding: {
          top: insets.top + 130,
          bottom: screenHeight * SHEET_FRACTION + 24,
          left: 32,
          right: 32,
        },
        duration,
      });
    },
    [insets.top, screenHeight],
  );

  // Open framed on you and the nearest points (once, when they first load):
  // centring on the user alone often left every nearby sheet off-screen or
  // under the sheet — Québec City's nearest sheets are in Maine.
  useEffect(() => {
    if (framed.current || !mapReady) return;
    const view = nearestPointsView(position, allPoints);
    if (view === null) return;
    framed.current = true;
    frame(view, 0);
  }, [mapReady, position, allPoints, frame]);

  // Checking an activity must SHOW its points: when none of them is on screen,
  // re-frame on you and the nearest ones (the zecs for "Hunting" may all be
  // north of a view opened on the nearest topo sheets).
  const framedActivity = useRef(initialFilter.activity ?? null);
  useEffect(() => {
    const activity = filter.activity ?? null;
    if (activity === framedActivity.current) return;
    framedActivity.current = activity;
    if (activity === null || !mapReady || bounds === null) return;
    if (pointsInSheetView(allPoints, bounds, SHEET_FRACTION).length > 0) return;
    const view = nearestPointsView(position, allPoints, 12);
    if (view !== null) frame(view, 400);
  }, [filter.activity, mapReady, bounds, allPoints, position, frame]);

  const sheetRows = useMemo(
    () =>
      sortPointsByDistance(inView, bounds === null ? position : boundsCenter(bounds)).slice(
        0,
        SHEET_ROWS,
      ),
    [inView, bounds, position],
  );
  // The tapped point, resolved against everything loaded (not just what the
  // filter leaves), so retyping the filter does not close an open card.
  const selected = useMemo((): ExplorePoint | undefined => {
    if (selectedRef === null) return undefined;
    if (selectedRef.kind === 'place') {
      return placePoints(collections).find((p) => p.key === selectedRef.key);
    }
    const item = items.find((i) => i.id === selectedRef.key);
    if (item === undefined) return undefined;
    const centre = item.bbox !== undefined ? bboxCenter(item.bbox) : { latitude: 0, longitude: 0 };
    return { kind: 'map', key: item.id, item, ...centre };
  }, [items, collections, selectedRef]);
  const selectedItem = selected?.kind === 'map' ? selected.item : undefined;
  const sourcesById = useMemo(
    () => new globalThis.Map((index?.sources ?? []).map((s) => [s.id, s.name])),
    [index],
  );

  const pending =
    bounds !== null && index !== null
      ? pendingShardCountInBounds(index.shards, bounds, unavailableShardIds(), category)
      : 0;

  const searchThisArea = useCallback(
    (view: ExploreBounds | null = bounds) => {
      if (view === null || status !== 'ready') return;
      void ensureShardsInBounds(view, category);
    },
    [bounds, status, ensureShardsInBounds, category],
  );

  // Load the first view's shards without a tap: an empty map on arrival
  // reads as "no maps here", not "tap to search".
  useEffect(() => {
    if (autoSearched.current || bounds === null || status !== 'ready') return;
    autoSearched.current = true;
    searchThisArea(bounds);
  }, [bounds, status, searchThisArea]);

  const onView = useCallback((raw: readonly [number, number, number, number], z: number) => {
    const view = normalizeBounds(raw);
    setBounds(view);
    setZoom(z);
    // Same object back while the view stays inside it: no re-cluster on a pan.
    setCullBox((previous) => cullWindow(view, previous));
  }, []);

  const readView = useCallback(() => {
    void mapRef.current
      ?.getViewState()
      .then((vs) => onView(vs.bounds, vs.zoom))
      .catch(() => undefined); // mid-teardown
  }, [onView]);

  const onSourcePress = useCallback(
    (e: NativeSyntheticEvent<{ features: GeoJSON.Feature[] }>) => {
      // A point/cluster tap must not bubble to the map's "tap empty map =
      // deselect" handler.
      e.stopPropagation();
      const feature = e.nativeEvent.features[0];
      if (feature === undefined) return;
      const props = (feature.properties ?? null) as Record<string, unknown> | null;
      const clusterId = clusterIdOf({ properties: props });
      if (clusterId !== null && feature.geometry.type === 'Point') {
        const [lng, lat] = feature.geometry.coordinates;
        void sourceRef.current
          ?.getClusterExpansionZoom(clusterId)
          .catch(() => null)
          .then((expansion) => {
            cameraRef.current?.easeTo({
              center: [lng ?? 0, lat ?? 0],
              zoom: clusterTapZoom(expansion, zoom),
              duration: 400,
            });
          });
        return;
      }
      const tapped = tappedPointOf({ properties: props });
      if (tapped !== null) setSelectedRef(tapped);
    },
    [zoom],
  );

  const footprint = useMemo(
    () => (selectedItem?.bbox !== undefined ? footprintFeature(selectedItem.bbox) : null),
    [selectedItem],
  );

  const pointColors = useMemo(
    () => ({
      cluster: t.explore.cluster,
      clusterRing: t.explore.clusterRing,
      clusterInk: t.explore.clusterInk,
      map: t.explore.point,
      place: t.explore.trailBadge,
    }),
    [t],
  );
  const clusterPaint = useMemo(() => exploreClusterPaint(pointColors), [pointColors]);
  const pointPaint = useMemo(() => explorePointPaint(pointColors), [pointColors]);

  const empty = exploreEmptyState({
    activity: filter.activity,
    pointCount: allPoints.length,
    searchable: pending > 0,
    loading: loadingShards || status === 'loading' || status === 'idle',
  });
  const activityLabel =
    filter.activity != null ? CATALOG_ACTIVITY_LABELS[filter.activity].toLowerCase() : '';

  const selectedDistance = selected === undefined ? null : pointDistanceMeters(selected, position);
  const installStatus =
    selectedItem === undefined ? null : installStatusFor(selectedItem, libraryMaps);
  const downloading = selectedItem !== undefined && selectedItem.id in downloads;
  const primary =
    selectedItem === undefined
      ? null
      : downloading
        ? { label: 'Cancel download', onPress: () => flow.cancel(selectedItem) }
        : installStatus === 'installed'
          ? { label: 'Open on map', onPress: () => flow.open(selectedItem) }
          : installStatus === 'update-available'
            ? { label: 'Update', onPress: () => flow.update(selectedItem) }
            : { label: 'Download · Free', onPress: () => flow.requestDownload(selectedItem) };

  const initialViewState = useMemo(
    () =>
      position !== null
        ? {
            center: [position.longitude, position.latitude] as [number, number],
            zoom: EXPLORE_MAP_START_ZOOM,
          }
        : { center: [-72, 46] as [number, number], zoom: 3 },
    // Only the first render's position seeds the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const chrome = {
    backgroundColor: t.surface,
    borderColor: t.outlineVariant,
  };

  return (
    <View style={[styles.fill, { backgroundColor: t.background }]}>
      <Map
        ref={mapRef}
        style={styles.fill}
        mapStyle={style}
        compass={false}
        onDidFinishLoadingMap={() => {
          setMapReady(true);
          readView();
        }}
        onRegionDidChange={(e) => onView(e.nativeEvent.bounds, e.nativeEvent.zoom)}
        onPress={() => {
          Keyboard.dismiss();
          setSelectedRef(null);
        }}
      >
        <Camera ref={cameraRef} initialViewState={initialViewState} />
        {footprint !== null && (
          <GeoJSONSource id="explore-footprint" data={footprint}>
            <Layer
              id="explore-footprint-fill"
              type="fill"
              paint={{ 'fill-color': t.explore.footprint, 'fill-opacity': 0.12 }}
            />
            <Layer
              id="explore-footprint-line"
              type="line"
              paint={{ 'line-color': t.explore.footprint, 'line-width': 2 }}
            />
          </GeoJSONSource>
        )}
        <GeoJSONSource
          ref={sourceRef}
          id={SOURCE_ID}
          data={points}
          cluster
          clusterRadius={50}
          clusterMaxZoom={12}
          onPress={onSourcePress}
        >
          <Layer
            id="explore-clusters"
            type="circle"
            filter={EXPLORE_CLUSTER_FILTER as never}
            paint={clusterPaint as never}
          />
          {countFont !== null && (
            <Layer
              id="explore-cluster-count"
              type="symbol"
              filter={EXPLORE_CLUSTER_FILTER as never}
              layout={{ ...EXPLORE_CLUSTER_COUNT_LAYOUT, 'text-font': [...countFont] } as never}
              paint={{ 'text-color': t.explore.clusterInk }}
            />
          )}
          <Layer
            id="explore-points"
            type="circle"
            filter={EXPLORE_POINT_FILTER as never}
            paint={pointPaint as never}
          />
        </GeoJSONSource>
      </Map>

      {/* Top chrome: back, filter field, list toggle; then the filter chips. */}
      <View style={[styles.top, { top: insets.top + space.sm }]} pointerEvents="box-none">
        <View style={styles.topRow}>
          <Pressable
            onPress={goBack}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={[styles.round, chrome]}
          >
            <Icon source="arrow-left" size={22} color={t.ink} />
          </Pressable>
          <View style={[styles.field, chrome]}>
            <Icon source="magnify" size={18} color={t.inkMuted} />
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Filter these maps"
              placeholderTextColor={t.inkMuted}
              accessibilityLabel="Filter the maps on this map"
              returnKeyType="search"
              onSubmitEditing={() => Keyboard.dismiss()}
              autoCorrect={false}
              style={[styles.input, { color: t.ink, fontFamily: theme.fonts.bodyLarge.fontFamily }]}
            />
          </View>
          <Pressable
            onPress={showList}
            accessibilityRole="button"
            accessibilityLabel="Show as a list"
            style={[styles.round, chrome]}
          >
            <Icon source="format-list-bulleted" size={22} color={t.ink} />
          </Pressable>
        </View>
        <ExploreFilterBar
          filter={filter}
          onChange={setFilter}
          items={items}
          sources={index?.sources ?? []}
          placeCounts={placeCounts}
        />
        {(pending > 0 || loadingShards) && (
          <Pressable
            onPress={() => searchThisArea()}
            disabled={loadingShards}
            accessibilityRole="button"
            accessibilityState={{ busy: loadingShards }}
            style={[styles.searchArea, { backgroundColor: t.surface }]}
          >
            {loadingShards && <ActivityIndicator size={16} />}
            <Text style={[styles.searchAreaText, { color: t.inkVariant }]}>
              {loadingShards ? 'Loading maps…' : 'Search this area'}
            </Text>
          </Pressable>
        )}
      </View>

      {/* The checked activity has nothing to draw: say so, never a blank map. */}
      {empty !== null && selected === undefined && (
        <View
          pointerEvents="box-none"
          style={[styles.emptyWrap, { bottom: screenHeight * SHEET_FRACTION + space.xl }]}
        >
          <View
            testID="explore-map-empty"
            accessibilityRole="summary"
            style={[styles.emptyCard, chrome]}
          >
            <Icon source="map-search-outline" size={28} color={t.explore.accent} />
            <Text style={[styles.emptyTitle, { color: t.ink }]}>
              {empty === 'none'
                ? `No ${activityLabel} maps or places yet`
                : `No ${activityLabel} maps loaded here`}
            </Text>
            <Text style={[styles.emptyBody, { color: t.inkVariant }]}>
              {empty === 'none'
                ? 'We add maps as their publishers allow it. Try another activity, or browse everything.'
                : 'Search this area to look for more, or browse everything.'}
            </Text>
            <View style={styles.emptyActions}>
              {empty === 'searchable' && (
                <Pressable
                  onPress={() => searchThisArea()}
                  accessibilityRole="button"
                  style={[styles.emptyButton, { backgroundColor: t.library.chipOn }]}
                >
                  <Text style={[styles.emptyButtonText, { color: t.library.chipOnInk }]}>
                    Search here
                  </Text>
                </Pressable>
              )}
              <Pressable
                onPress={() =>
                  setFilter((current) => {
                    const next = { ...current };
                    delete next.activity;
                    return next;
                  })
                }
                accessibilityRole="button"
                style={[
                  styles.emptyButton,
                  empty === 'none'
                    ? { backgroundColor: t.library.chipOn }
                    : { borderWidth: 1, borderColor: t.outlineVariant },
                ]}
              >
                <Text
                  style={[
                    styles.emptyButtonText,
                    { color: empty === 'none' ? t.library.chipOnInk : t.ink },
                  ]}
                >
                  Show all maps
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}

      {/* Bottom sheet: the selected point's card, or what is in view. */}
      <View
        testID="explore-map-sheet"
        style={[
          styles.sheet,
          {
            backgroundColor: t.surface,
            paddingBottom: insets.bottom + space.md,
          },
          // The list sheet keeps one height whatever it lists (#459); the
          // selected-map card sizes to itself — it shows no "in this area".
          selected !== undefined
            ? { maxHeight: screenHeight * SHEET_FRACTION }
            : { height: screenHeight * SHEET_FRACTION },
        ]}
      >
        <View style={[styles.handle, { backgroundColor: t.outlineVariant }]} />
        {selected !== undefined ? (
          <View style={styles.selected}>
            {selected.kind === 'map' ? (
              <Pressable
                onPress={() => router.push(exploreItemHref(selected.item.id))}
                accessibilityRole="button"
                accessibilityLabel={`${selected.item.title}. Details`}
                style={styles.selectedRow}
              >
                <View style={[styles.preview, { borderColor: t.outlineVariant }]}>
                  <MapPreview
                    thumbnailUrl={selected.item.thumbnailUrl}
                    seed={selected.item.id}
                    width={64}
                    height={64}
                  />
                </View>
                <View style={styles.rowText}>
                  <Text numberOfLines={2} style={[styles.rowTitle, { color: t.ink }]}>
                    {selected.item.title}
                  </Text>
                  <Text numberOfLines={2} style={[styles.rowMeta, { color: t.inkMuted }]}>
                    {itemMeta(selected.item, sourcesById.get(selected.item.sourceId))}
                  </Text>
                  {selectedDistance !== null && (
                    <Text style={[styles.distance, { color: t.explore.accent }]}>
                      {formatDistanceAway(selectedDistance, units)}
                    </Text>
                  )}
                </View>
              </Pressable>
            ) : (
              <View style={styles.selectedRow} testID="explore-map-place-card">
                <View style={[styles.placeBadge, { backgroundColor: t.explore.collectionBadge }]}>
                  <Icon source="map-marker" size={30} color={t.explore.collectionBadgeInk} />
                </View>
                <View style={styles.rowText}>
                  <Text numberOfLines={2} style={[styles.rowTitle, { color: t.ink }]}>
                    {selected.place.name}
                  </Text>
                  <Text numberOfLines={2} style={[styles.rowMeta, { color: t.inkMuted }]}>
                    {placeMeta(selected)}
                  </Text>
                  {selectedDistance !== null && (
                    <Text style={[styles.distance, { color: t.explore.accent }]}>
                      {formatDistanceAway(selectedDistance, units)}
                    </Text>
                  )}
                </View>
              </View>
            )}
            {selected.kind === 'place' && (
              <Text style={[styles.rowMeta, { color: t.inkVariant }]}>
                {`${selected.collection.publisher} publishes this place’s maps on its own site. Open the PDF with Inukshuk from there.`}
              </Text>
            )}
            <View style={styles.selectedActions}>
              {selected.kind === 'map' && primary !== null ? (
                <>
                  <Pressable
                    onPress={primary.onPress}
                    accessibilityRole="button"
                    style={[styles.details, { backgroundColor: t.library.chipOn }]}
                  >
                    <Text style={[styles.detailsText, { color: t.library.chipOnInk }]}>
                      {primary.label}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => router.push(exploreItemHref(selected.item.id))}
                    accessibilityRole="button"
                    style={[styles.secondary, { borderColor: t.outlineVariant }]}
                  >
                    <Text style={[styles.detailsText, { color: t.ink }]}>Details</Text>
                  </Pressable>
                </>
              ) : selected.kind === 'place' ? (
                <Pressable
                  onPress={() => void openExternalLink(selected.place.url)}
                  accessibilityRole="link"
                  accessibilityHint="Opens the place's maps on the publisher's website"
                  style={[styles.details, styles.linkOut, { backgroundColor: t.library.chipOn }]}
                >
                  <Text
                    numberOfLines={1}
                    style={[styles.detailsText, { color: t.library.chipOnInk }]}
                  >
                    {`Open on ${hostOf(selected.collection.homepage)}`}
                  </Text>
                  <Icon source="open-in-new" size={18} color={t.library.chipOnInk} />
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => setSelectedRef(null)}
                accessibilityRole="button"
                accessibilityLabel="Close"
                style={[styles.round, chrome]}
              >
                <Icon source="close" size={20} color={t.ink} />
              </Pressable>
            </View>
          </View>
        ) : (
          <>
            <Text style={[styles.count, { color: t.inkMuted }]}>
              {bounds === null ? 'Loading the map…' : inAreaLabel(inView).toUpperCase()}
            </Text>
            <FlatList
              style={styles.fill}
              data={sheetRows}
              keyExtractor={(point) => point.key}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item: point }) => (
                <Pressable
                  onPress={() => setSelectedRef({ kind: point.kind, key: point.key })}
                  accessibilityRole="button"
                  accessibilityLabel={point.kind === 'map' ? point.item.title : point.place.name}
                  style={styles.sheetRow}
                >
                  {point.kind === 'map' ? (
                    <View style={[styles.previewSmall, { borderColor: t.outlineVariant }]}>
                      <MapPreview
                        thumbnailUrl={point.item.thumbnailUrl}
                        seed={point.item.id}
                        width={48}
                        height={48}
                      />
                    </View>
                  ) : (
                    <View
                      style={[
                        styles.placeBadgeSmall,
                        { backgroundColor: t.explore.collectionBadge },
                      ]}
                    >
                      <Icon source="map-marker" size={24} color={t.explore.collectionBadgeInk} />
                    </View>
                  )}
                  <View style={styles.rowText}>
                    <Text numberOfLines={1} style={[styles.rowTitle, { color: t.ink }]}>
                      {point.kind === 'map' ? point.item.title : point.place.name}
                    </Text>
                    <Text numberOfLines={1} style={[styles.rowMeta, { color: t.inkMuted }]}>
                      {point.kind === 'map'
                        ? itemMeta(point.item, sourcesById.get(point.item.sourceId))
                        : placeMeta(point)}
                    </Text>
                  </View>
                  {point.kind === 'place' && (
                    <Icon source="open-in-new" size={18} color={t.inkMuted} />
                  )}
                </Pressable>
              )}
              ListEmptyComponent={
                bounds === null || empty !== null ? null : (
                  <Text style={[styles.empty, { color: t.inkMuted }]}>
                    {collections.length > 0
                      ? 'Move the map to find maps and places in another area.'
                      : 'Move the map to find maps in another area.'}
                  </Text>
                )
              }
              initialNumToRender={6}
              windowSize={5}
            />
          </>
        )}
      </View>
      {flow.overlays}
    </View>
  );
}

const shadow = {
  shadowColor: palette.shadow,
  shadowOpacity: 0.18,
  shadowRadius: 8,
  shadowOffset: { width: 0, height: 2 },
  elevation: 4,
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
  top: { position: 'absolute', left: 0, right: 0, gap: space.xs },
  topRow: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg },
  round: {
    width: target.min,
    height: target.min,
    borderRadius: target.min / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow,
  },
  field: {
    flex: 1,
    height: target.min,
    borderRadius: target.min / 2,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    ...shadow,
  },
  input: { flex: 1, minWidth: 0, height: target.min, padding: 0, fontSize: 15 },
  searchArea: {
    alignSelf: 'center',
    minHeight: 40,
    paddingHorizontal: space.lg,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.xs,
    ...shadow,
  },
  searchAreaText: { fontSize: 14, lineHeight: 18, fontWeight: '700' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingTop: 10,
    paddingHorizontal: space.lg,
    gap: 10,
    ...shadow,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2 },
  count: { fontSize: 13, lineHeight: 18, fontWeight: '700', letterSpacing: 0.3 },
  empty: { fontSize: 14, lineHeight: 20, paddingVertical: space.sm },
  selected: { gap: space.md },
  selectedRow: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  selectedActions: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  preview: { width: 64, height: 64, borderRadius: space.md, borderWidth: 1, overflow: 'hidden' },
  previewSmall: {
    width: 48,
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
  },
  rowText: { flex: 1, minWidth: 0, gap: 3 },
  rowTitle: { fontSize: 16, lineHeight: 21, fontWeight: '800' },
  rowMeta: { fontSize: 13, lineHeight: 18 },
  sheetRow: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 6,
  },
  details: {
    flex: 1,
    minHeight: target.min,
    borderRadius: target.min / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailsText: { fontSize: 16, lineHeight: 20, fontWeight: '800' },
  secondary: {
    minHeight: target.min,
    paddingHorizontal: space.lg,
    borderRadius: target.min / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkOut: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.md },
  distance: { fontSize: 13, lineHeight: 18, fontWeight: '700' },
  placeBadge: {
    width: 64,
    height: 64,
    borderRadius: space.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeBadgeSmall: {
    width: 48,
    height: 48,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: space.xl,
  },
  emptyCard: {
    maxWidth: 360,
    borderRadius: 18,
    borderWidth: 1,
    padding: space.lg,
    gap: space.sm,
    alignItems: 'center',
    ...shadow,
  },
  emptyTitle: { fontSize: 17, lineHeight: 22, fontWeight: '800', textAlign: 'center' },
  emptyBody: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  emptyActions: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  emptyButton: {
    minHeight: target.min,
    paddingHorizontal: space.lg,
    borderRadius: target.min / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyButtonText: { fontSize: 15, lineHeight: 20, fontWeight: '800' },
});
