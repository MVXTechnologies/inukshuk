import { VECTOR_BASEMAP_ENABLED } from '@core/features/flags';
import {
  categoryForKind,
  filterExploreItems,
  type ExploreFilter,
} from '@core/catalog/exploreFacets';
import {
  boundsCenter,
  catalogPointCollection,
  clusterIdOf,
  clusterTapZoom,
  EXPLORE_MAP_START_ZOOM,
  footprintFeature,
  itemsInBounds,
  nearestItemsView,
  trimBoundsBottom,
  normalizeBounds,
  pendingShardCountInBounds,
  pointItemIdOf,
  type ExploreBounds,
} from '@core/catalog/exploreMap';
import { sortCatalogItems } from '@core/catalog/nearest';
import type { CatalogItem } from '@core/catalog/schema';
import { CATALOG_KIND_LABELS } from '@core/catalog/taxonomy';
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

/**
 * Explore on a map (#447, board `MapView.dc.html`): the loaded catalog as
 * clustered points on the app's own base style, filter chips on top, "Search
 * this area" once the view reaches shards not loaded yet, and a bottom sheet
 * listing the maps in view — or, after a point tap, that map with "Details"
 * and its footprint drawn as a rectangle. Tapping a cluster zooms in.
 *
 * Nothing here ever loads the whole catalog: "Search this area" pulls the
 * shards reaching into the view nearest its centre, under the store's usual
 * count and byte budgets (`catalogStore.ensureShardsInBounds`), and the button
 * stays up while the view still has unloaded shards.
 *
 * The sheet is a plain themed View, not a paper Surface: an absolutely
 * positioned Surface collapses its flex column on iOS.
 */

const SOURCE_ID = 'explore-catalog';
/** Rows the sheet lists — enough to scan, never a 5 000-row FlatList in a sheet. */
const SHEET_ROWS = 50;
/** Share of the screen the bottom sheet covers (its maxHeight). */
const SHEET_FRACTION = 0.42;

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

export function ExploreMapScreen({ initialFilter }: { initialFilter: ExploreFilter }) {
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
  const tileUrl = useSettingsStore((s) => s.tileUrl);
  const showHillshade = useSettingsStore((s) => s.showHillshade);
  const contours = useSettingsStore((s) => s.terrainContours);

  const [filter, setFilter] = useState<ExploreFilter>(initialFilter);
  const [text, setText] = useState('');
  const [bounds, setBounds] = useState<ExploreBounds | null>(null);
  const [zoom, setZoom] = useState(EXPLORE_MAP_START_ZOOM);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const autoSearched = useRef(false);
  const framed = useRef(false);
  // The native map ignores camera commands until it has loaded.
  const [mapReady, setMapReady] = useState(false);
  // The sheet's real height: it shrinks when it has nothing to list, and
  // only the map it covers is off-screen for "in this area".
  const [sheetHeight, setSheetHeight] = useState(0);

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
    () =>
      buildOsmStyle(tileUrl, false, 'map', showHillshade, vector ? { vectorBasemap: vector } : {}),
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
  const points = useMemo(() => catalogPointCollection(filtered), [filtered]);
  // Only what the sheet leaves visible counts as "in this area" — the maps
  // under the sheet are not on screen (emulator check, 2026-09-29).
  const inView = useMemo(
    () =>
      bounds === null
        ? []
        : itemsInBounds(
            filtered,
            trimBoundsBottom(bounds, screenHeight > 0 ? sheetHeight / screenHeight : 0),
          ),
    [filtered, bounds, sheetHeight, screenHeight],
  );

  // Open framed on you and the nearest maps (once, when they first load):
  // centring on the user alone often left every nearby sheet off-screen or
  // under the sheet — Québec City's nearest sheets are in Maine.
  useEffect(() => {
    if (framed.current || !mapReady) return;
    const view = nearestItemsView(position, filtered);
    if (view === null) return;
    framed.current = true;
    cameraRef.current?.fitBounds(view, {
      padding: {
        top: insets.top + 130,
        bottom: screenHeight * SHEET_FRACTION + 24,
        left: 32,
        right: 32,
      },
      duration: 0,
    });
  }, [mapReady, position, filtered, insets.top, screenHeight]);
  const sheetRows = useMemo(
    () =>
      sortCatalogItems(inView, bounds === null ? position : boundsCenter(bounds)).slice(
        0,
        SHEET_ROWS,
      ),
    [inView, bounds, position],
  );
  const selected = useMemo(
    () => (selectedId === null ? undefined : items.find((i) => i.id === selectedId)),
    [items, selectedId],
  );
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

  const readView = useCallback(() => {
    void mapRef.current
      ?.getViewState()
      .then((vs) => {
        setBounds(normalizeBounds(vs.bounds));
        setZoom(vs.zoom);
      })
      .catch(() => undefined); // mid-teardown
  }, []);

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
      const itemId = pointItemIdOf({ properties: props });
      if (itemId !== null) setSelectedId(itemId);
    },
    [zoom],
  );

  const footprint = useMemo(
    () => (selected?.bbox !== undefined ? footprintFeature(selected.bbox) : null),
    [selected],
  );

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
        onRegionDidChange={(e) => {
          setBounds(normalizeBounds(e.nativeEvent.bounds));
          setZoom(e.nativeEvent.zoom);
        }}
        onPress={() => {
          Keyboard.dismiss();
          setSelectedId(null);
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
            filter={['has', 'point_count']}
            paint={{
              'circle-color': t.explore.cluster,
              'circle-radius': ['step', ['get', 'point_count'], 18, 10, 22, 50, 27],
              'circle-stroke-width': 3,
              'circle-stroke-color': t.explore.clusterRing,
            }}
          />
          {countFont !== null && (
            <Layer
              id="explore-cluster-count"
              type="symbol"
              filter={['has', 'point_count']}
              layout={{
                'text-field': ['get', 'point_count_abbreviated'],
                'text-font': [...countFont],
                'text-size': 14,
                'text-allow-overlap': true,
              }}
              paint={{ 'text-color': t.explore.clusterInk }}
            />
          )}
          <Layer
            id="explore-points"
            type="circle"
            filter={['!', ['has', 'point_count']]}
            paint={{
              'circle-color': t.explore.point,
              'circle-radius': 8,
              'circle-stroke-width': 2,
              'circle-stroke-color': t.explore.clusterRing,
            }}
          />
        </GeoJSONSource>
      </Map>

      {/* Top chrome: list toggle + filter field, then the filter chips. */}
      <View style={[styles.top, { top: insets.top + space.sm }]} pointerEvents="box-none">
        <View style={styles.topRow}>
          <Pressable
            onPress={() => router.replace(exploreListHref(filter))}
            accessibilityRole="button"
            accessibilityLabel="Show as a list"
            style={[styles.round, chrome]}
          >
            <Icon source="format-list-bulleted" size={22} color={t.ink} />
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
        </View>
        <ExploreFilterBar
          filter={filter}
          onChange={setFilter}
          items={items}
          sources={index?.sources ?? []}
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

      {/* Bottom sheet: the selected map, or the maps in view. */}
      <View
        onLayout={(e) => setSheetHeight(e.nativeEvent.layout.height)}
        style={[
          styles.sheet,
          {
            backgroundColor: t.surface,
            paddingBottom: insets.bottom + space.md,
            maxHeight: screenHeight * SHEET_FRACTION,
          },
        ]}
      >
        <View style={[styles.handle, { backgroundColor: t.outlineVariant }]} />
        {selected !== undefined ? (
          <View style={styles.selected}>
            <Pressable
              onPress={() => router.push(exploreItemHref(selected.id))}
              accessibilityRole="button"
              accessibilityLabel={`${selected.title}. Details`}
              style={styles.selectedRow}
            >
              <View style={[styles.preview, { borderColor: t.outlineVariant }]}>
                <MapPreview
                  thumbnailUrl={selected.thumbnailUrl}
                  seed={selected.id}
                  width={64}
                  height={64}
                />
              </View>
              <View style={styles.rowText}>
                <Text numberOfLines={2} style={[styles.rowTitle, { color: t.ink }]}>
                  {selected.title}
                </Text>
                <Text numberOfLines={2} style={[styles.rowMeta, { color: t.inkMuted }]}>
                  {itemMeta(selected, sourcesById.get(selected.sourceId))}
                </Text>
              </View>
            </Pressable>
            <View style={styles.selectedActions}>
              <Pressable
                onPress={() => router.push(exploreItemHref(selected.id))}
                accessibilityRole="button"
                style={[styles.details, { backgroundColor: t.library.chipOn }]}
              >
                <Text style={[styles.detailsText, { color: t.library.chipOnInk }]}>Details</Text>
              </Pressable>
              <Pressable
                onPress={() => setSelectedId(null)}
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
              {bounds === null
                ? 'Loading the map…'
                : `${inView.length.toLocaleString('en-US')} ${
                    inView.length === 1 ? 'map' : 'maps'
                  } in this area`.toUpperCase()}
            </Text>
            <FlatList
              data={sheetRows}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => setSelectedId(item.id)}
                  accessibilityRole="button"
                  accessibilityLabel={item.title}
                  style={styles.sheetRow}
                >
                  <View style={[styles.previewSmall, { borderColor: t.outlineVariant }]}>
                    <MapPreview
                      thumbnailUrl={item.thumbnailUrl}
                      seed={item.id}
                      width={48}
                      height={48}
                    />
                  </View>
                  <View style={styles.rowText}>
                    <Text numberOfLines={1} style={[styles.rowTitle, { color: t.ink }]}>
                      {item.title}
                    </Text>
                    <Text numberOfLines={1} style={[styles.rowMeta, { color: t.inkMuted }]}>
                      {itemMeta(item, sourcesById.get(item.sourceId))}
                    </Text>
                  </View>
                </Pressable>
              )}
              initialNumToRender={6}
              windowSize={5}
            />
          </>
        )}
      </View>
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
});
