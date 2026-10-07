/**
 * Explore → Activity → Climbing (mockups 01–04): the crag layer on the
 * Explore map, the Style / Grade chips, the "N crags in this area" list and
 * the crag card with Download and Topo — all from `crags.pmtiles` (rendered
 * features, never a worldwide list).
 */
import { formatDistanceAway } from '@core/catalog/nearbySections';
import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import { cragAreaLabel, cragsFromFeatures, CRAG_SHEET_ROWS } from '@core/climbing/explore';
import { STYLE_LABELS, type ClimbStyle, type CragSummary } from '@core/climbing/crag';
import { pointDistanceMeters } from '@core/catalog/explorePoints';
import {
  buildCragTileLayers,
  CRAG_SOURCE_MAXZOOM,
  CRAG_SOURCE_MINZOOM,
  cragFacetFilter,
  cragLayerIds,
  type CragGradeFacet,
} from '@core/map/climbingStyle';
import type { Units } from '@core/format';
import { cragTilesUrl } from '@data/climbing';
import { Images, Layer, VectorSource, type MapRef } from '@maplibre/maplibre-react-native';
import { useClimbingStore } from '@state/climbingStore';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { type ComponentProps, type RefObject, useCallback, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';

import { climbingImages } from './climbingImages';
import { CragCard, CragRow } from './CragCard';
import { DownloadCragSheet } from './DownloadCragSheet';
import { CragDownloadError, downloadCrag, estimateCragMap } from './climbingActions';
import { useGradeSystem } from './ClimbingParts';
import { cragHref } from './climbingRoutes';

const SOURCE_ID = 'explore-crags';
const LAYER_PREFIX = 'explore-crags';
const STYLE_CHOICES: ClimbStyle[] = ['sport', 'trad', 'tr', 'boulder', 'ice'];

export function gradeChoiceLabels(system: 'yds' | 'french'): Record<CragGradeFacet, string> {
  return system === 'yds'
    ? { easy: 'Up to 5.9', mid: '5.10–5.11', hard: '5.12 and up' }
    : { easy: 'Up to 5c', mid: '6a–7a', hard: '7a+ and up' };
}

export interface ExploreCragsState {
  enabled: boolean;
  styles: ClimbStyle[];
  grade: CragGradeFacet | null;
  setStyles: (s: ClimbStyle[]) => void;
  setGrade: (g: CragGradeFacet | null) => void;
  crags: CragSummary[];
  selected: CragSummary | null;
  select: (c: CragSummary | null) => void;
  /** Re-read the crags in view (after the camera settles). */
  refresh: (visibleTopPx?: number, visibleBottomPx?: number, widthPx?: number) => void;
  onSourcePress: (e: NativeSyntheticEvent<{ features: GeoJSON.Feature[] }>) => void;
  layerFilter: ExpressionSpecification | null;
}

export function useExploreCrags({
  enabled,
  mapRef,
  text,
  centre,
}: {
  enabled: boolean;
  mapRef: RefObject<MapRef | null>;
  text: string;
  centre: { latitude: number; longitude: number } | null;
}): ExploreCragsState {
  const [styles, setStyles] = useState<ClimbStyle[]>([]);
  const [grade, setGrade] = useState<CragGradeFacet | null>(null);
  const [features, setFeatures] = useState<GeoJSON.Feature[]>([]);
  const [selected, select] = useState<CragSummary | null>(null);
  const reqRef = useRef(0);
  const layerFilter = useMemo(() => cragFacetFilter({ styles, grade }), [styles, grade]);
  const ids = cragLayerIds(LAYER_PREFIX);

  const refresh = useCallback(
    (top?: number, bottom?: number, width?: number) => {
      if (!enabled) return;
      const req = ++reqRef.current;
      const box =
        top !== undefined && bottom !== undefined && width !== undefined && bottom > top
          ? ([
              [0, top],
              [width, bottom],
            ] as [[number, number], [number, number]])
          : null;
      const options = { layers: [ids.badgesLow, ids.badgesHigh] };
      const query = box
        ? mapRef.current?.queryRenderedFeatures(box, options)
        : mapRef.current?.queryRenderedFeatures(options);
      void query
        ?.then((f) => {
          if (req === reqRef.current) setFeatures(f);
        })
        .catch(() => undefined);
    },
    [enabled, mapRef, ids.badgesLow, ids.badgesHigh],
  );

  const crags = useMemo(
    () => cragsFromFeatures(features, { centre, text, limit: CRAG_SHEET_ROWS }),
    [features, centre, text],
  );

  const onSourcePress = useCallback((e: NativeSyntheticEvent<{ features: GeoJSON.Feature[] }>) => {
    e.stopPropagation();
    const [c] = cragsFromFeatures(e.nativeEvent.features, { centre: null, limit: 1 });
    if (c) select(c);
  }, []);

  return {
    enabled,
    styles,
    grade,
    setStyles,
    setGrade,
    crags,
    selected,
    select,
    refresh,
    onSourcePress,
    layerFilter,
  };
}

/** The crag layer, as children of the Explore map. */
export function ExploreCragLayers({
  state,
  text,
  font,
}: {
  state: ExploreCragsState;
  text: string;
  /** The style's label font; null = a style without glyphs (no labels). */
  font: readonly string[] | null;
}) {
  const theme = useTheme();
  const saved = useClimbingStore((s) => s.saved);
  const tiles = cragTilesUrl();
  const dark = theme.dark ? 'dark' : 'light';
  const layers = useMemo(() => {
    const q = text.trim().toLowerCase();
    const textFilter: ExpressionSpecification | null =
      q === '' ? null : ['in', q, ['downcase', ['get', 'n']]];
    const parts = [state.layerFilter, textFilter].filter(
      (p): p is ExpressionSpecification => p !== null,
    );
    return buildCragTileLayers({
      theme: dark,
      font: font ?? [],
      noLabels: font === null,
      source: SOURCE_ID,
      prefix: LAYER_PREFIX,
      saved: saved.map((s) => s.uid),
      savedMode: 'filled',
      filter:
        parts.length === 0
          ? null
          : parts.length === 1
            ? (parts[0] as ExpressionSpecification)
            : (['all', ...parts] as ExpressionSpecification),
    });
  }, [dark, saved, state.layerFilter, text, font]);
  if (!state.enabled || tiles === null) return null;
  return (
    <>
      <Images images={climbingImages(dark)} />
      <VectorSource
        id={SOURCE_ID}
        tiles={[tiles]}
        minzoom={CRAG_SOURCE_MINZOOM}
        maxzoom={CRAG_SOURCE_MAXZOOM}
        onPress={state.onSourcePress}
      >
        {layers.map((l) => (
          <Layer key={l.id} {...(l as ComponentProps<typeof Layer>)} />
        ))}
      </VectorSource>
    </>
  );
}

/** Style ▾ / Grade ▾ chips, each opening its choices inline (no Portal menus). */
export function CragFacetChips({ state }: { state: ExploreCragsState }) {
  const t = useSchemeTokens();
  const system = useGradeSystem();
  const [open, setOpen] = useState<'style' | 'grade' | null>(null);
  const gradeLabels = gradeChoiceLabels(system);
  const chip = (on: boolean) => [
    styles.chip,
    on
      ? { backgroundColor: t.library.chipOn, borderColor: t.library.chipOn }
      : { backgroundColor: t.surface, borderColor: t.outlineVariant },
  ];
  const ink = (on: boolean) => ({ color: on ? t.library.chipOnInk : t.ink });
  const styleOn = state.styles.length > 0;
  const gradeOn = state.grade !== null;
  return (
    <View style={styles.facets}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
      >
        <Pressable
          onPress={() => setOpen((o) => (o === 'style' ? null : 'style'))}
          accessibilityRole="button"
          accessibilityState={{ expanded: open === 'style' }}
          style={chip(styleOn)}
          testID="crag-chip-style"
        >
          <Text style={[styles.chipText, ink(styleOn)]}>
            {styleOn ? state.styles.map((s) => STYLE_LABELS[s]).join(', ') : 'Style'}
          </Text>
          <Icon
            source={open === 'style' ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={ink(styleOn).color}
          />
        </Pressable>
        <Pressable
          onPress={() => setOpen((o) => (o === 'grade' ? null : 'grade'))}
          accessibilityRole="button"
          accessibilityState={{ expanded: open === 'grade' }}
          style={chip(gradeOn)}
          testID="crag-chip-grade"
        >
          <Text style={[styles.chipText, ink(gradeOn)]}>
            {state.grade !== null ? gradeLabels[state.grade] : 'Grade'}
          </Text>
          <Icon
            source={open === 'grade' ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={ink(gradeOn).color}
          />
        </Pressable>
      </ScrollView>
      {open !== null && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          {open === 'style'
            ? STYLE_CHOICES.map((s) => {
                const on = state.styles.includes(s);
                return (
                  <Pressable
                    key={s}
                    onPress={() =>
                      state.setStyles(
                        on ? state.styles.filter((x) => x !== s) : [...state.styles, s],
                      )
                    }
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    style={chip(on)}
                  >
                    <Text style={[styles.chipText, ink(on)]}>{STYLE_LABELS[s]}</Text>
                  </Pressable>
                );
              })
            : (['easy', 'mid', 'hard'] as CragGradeFacet[]).map((g) => {
                const on = state.grade === g;
                return (
                  <Pressable
                    key={g}
                    onPress={() => state.setGrade(on ? null : g)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    style={chip(on)}
                  >
                    <Text style={[styles.chipText, ink(on)]}>{gradeLabels[g]}</Text>
                  </Pressable>
                );
              })}
        </ScrollView>
      )}
    </View>
  );
}

/**
 * The Explore sheet in Climbing mode: the selected crag's card (or its
 * download sheet), else the crags in view.
 */
export function ExploreCragSheet({
  state,
  position,
  units,
  loading,
  onSnack,
}: {
  state: ExploreCragsState;
  position: { latitude: number; longitude: number } | null;
  units: Units;
  loading: boolean;
  onSnack: (message: string) => void;
}) {
  const t = useSchemeTokens();
  const router = useRouter();
  const [confirming, setConfirming] = useState<string | null>(null);
  const downloads = useClimbingStore((s) => s.downloads);
  const selected = state.selected;
  const distance = (c: CragSummary) => {
    const d = pointDistanceMeters({ latitude: c.lat, longitude: c.lng }, position);
    return d === null ? null : formatDistanceAway(d, units);
  };
  const mapBytes = useMemo(
    () => (selected ? estimateCragMap([[selected.lng, selected.lat]]) : null),
    [selected],
  );
  const start = (withMap: boolean) => {
    if (!selected) return;
    const uid = selected.uid;
    void downloadCrag(uid, { withMap })
      .then(() => {
        setConfirming(null);
        onSnack(`${selected.name} is saved offline. It is on your main map too.`);
      })
      .catch((err: unknown) => {
        setConfirming(null);
        onSnack(
          err instanceof CragDownloadError ? err.message : `Couldn't download ${selected.name}`,
        );
      });
  };

  if (selected) {
    if (confirming === selected.uid || downloads[selected.uid]) {
      return (
        <DownloadCragSheet
          crag={selected}
          mapBytes={mapBytes ?? 0}
          onConfirm={start}
          onCancel={() => setConfirming(null)}
        />
      );
    }
    return (
      <CragCard
        crag={selected}
        distance={distance(selected)}
        mapBytes={mapBytes}
        download={downloads[selected.uid]}
        onDownload={() => setConfirming(selected.uid)}
        onTopo={() => router.push(cragHref(selected.uid))}
        onClose={() => state.select(null)}
      />
    );
  }
  return (
    <>
      <Text style={[styles.count, { color: t.inkMuted }]} testID="crag-area-count">
        {loading ? 'Loading the map…' : cragAreaLabel(state.crags).toUpperCase()}
      </Text>
      <FlatList
        style={styles.fill}
        data={state.crags}
        keyExtractor={(c) => c.uid}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <CragRow crag={item} distance={distance(item)} onPress={() => state.select(item)} />
        )}
        ListEmptyComponent={
          loading ? null : (
            <Text style={[styles.empty, { color: t.inkMuted }]}>
              Move or zoom the map to find crags. Nothing here yet? Help map it on OpenStreetMap or
              OpenBeta.
            </Text>
          )
        }
        initialNumToRender={6}
        windowSize={5}
      />
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  facets: { gap: space.xs },
  chipRow: { gap: space.sm, paddingHorizontal: space.lg },
  chip: {
    minHeight: 36,
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  chipText: { fontSize: 14, lineHeight: 18, fontWeight: '700' },
  count: { fontSize: 13, lineHeight: 18, fontWeight: '700', letterSpacing: 0.3 },
  empty: { fontSize: 14, lineHeight: 20, paddingVertical: space.sm },
});
