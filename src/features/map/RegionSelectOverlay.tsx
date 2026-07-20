/**
 * RegionSelectOverlay — an absolutely-positioned overlay over the map that
 * lets the user drag a rectangle to define a region for offline tile download.
 *
 * Four corner handles resize the box. A compact bottom sheet shows, per basemap,
 * a live preview of the drawn area with a checkbox, a quality (max-zoom) selector,
 * the summed tile/size estimate, and Download / Cancel. No MapLibre import: geo
 * conversion is injected via the `toGeo` prop.
 */

import type { ScreenRect } from '@core/geo/screenBounds';
import {
  overviewZoomFor,
  estimateRegionDownload,
  NATIVE_MAX_ZOOM,
  type Basemap,
} from '@core/geo/tiles';
import type { BoundingBox } from '@core/models';
import { formatBytes } from '@lib/format';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, View } from 'react-native';
import { Button, Icon, SegmentedButtons, Surface, Text, useTheme } from 'react-native-paper';

import { RegionPreviewThumb } from './RegionPreviewThumb';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Quality = 'standard' | 'high' | 'max';

interface Props {
  /**
   * Convert a screen point (px, relative to the overlay) to [lng, lat],
   * synchronously (from cached map bounds). Returns `null` when the bounds/layout
   * aren't ready yet (avoids a degenerate [0,0] "null island" estimate).
   */
  toGeo: (screen: { x: number; y: number }) => [number, number] | null;
  /**
   * Bumped by the owner whenever the map's cached bounds change (pan/zoom, or
   * the entry flatten settling). The drawn box then means a different area, so
   * the geometry is recomputed even though the box itself didn't move.
   */
  boundsVersion: number;
  /** The currently-active basemap — pre-checked in the layer picker. */
  activeBasemap: Basemap;
  /** OSM tile URL (from settings) used to build the preview thumbnails. */
  tileUrl: string;
  /**
   * The drawn rectangle is handed back in SCREEN space, not as bounds: the owner
   * re-derives the geographic bounds from freshly read flat-camera bounds, so
   * what gets downloaded is what is on screen (the displayed estimate may have
   * been computed against slightly older bounds).
   */
  onConfirm: (rect: ScreenRect, basemaps: Basemap[], maxZoom: number) => void;
  onCancel: () => void;
  /**
   * 'download' (default) shows layers/quality/estimate and gates on the tile
   * cap; 'makeMap' is just the box — the map maker's options sheet handles
   * everything else, so the confirm button says "Next" and passes no layers.
   */
  variant?: 'download' | 'makeMap';
}

/** Rectangle in screen-space pixels, relative to the overlay's top-left. */
type Box = ScreenRect;

/** The region geometry derived (async) from the box; quality/layers are applied on top. */
interface Geo {
  bbox: BoundingBox;
  minZoom: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HANDLE_SIZE = 28; // tap target for each corner handle (px)
const MIN_BOX = 48; // minimum box dimension (px)
const MAX_TILES = 25_000; // hard cap on total tiles (summed across layers)
const THUMB = 60; // preview thumbnail size (px)

const QUALITY_ZOOM: Record<Quality, number> = { standard: 15, high: 16, max: 17 };
const QUALITY_BUTTONS: { value: Quality; label: string }[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

const LAYERS: { key: Basemap; label: string }[] = [
  { key: 'map', label: 'Map' },
  { key: 'satellite', label: 'Satellite' },
  { key: 'relief', label: 'Relief' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RegionSelectOverlay({
  toGeo,
  boundsVersion,
  activeBasemap,
  tileUrl,
  onConfirm,
  onCancel,
  variant = 'download',
}: Props): ReactElement {
  const theme = useTheme();
  const makeMapMode = variant === 'makeMap';

  // Overlay dimensions, populated via onLayout.
  const overlaySize = useRef({ w: 0, h: 0 });

  // Current box in screen space — written by gesture handlers via ref,
  // mirrored to state only for rendering.
  const boxRef = useRef<Box>({ x: 0, y: 0, w: 0, h: 0 });
  const [box, setBox] = useState<Box>({ x: 0, y: 0, w: 0, h: 0 });
  const initialised = useRef(false);

  // Box snapshot at gesture start (written in onGrant, read in onMove).
  const startBox = useRef<Box>({ x: 0, y: 0, w: 0, h: 0 });

  // Region geometry (bbox + overview zoom), recomputed from the box.
  const [geo, setGeo] = useState<Geo | null>(null);

  // Which basemaps to download (the active one is pre-checked) and the quality.
  const [selected, setSelected] = useState<Record<Basemap, boolean>>({
    map: activeBasemap === 'map',
    satellite: activeBasemap === 'satellite',
    relief: activeBasemap === 'relief',
  });
  const [quality, setQuality] = useState<Quality>('high');

  // ---------------------------------------------------------------------------
  // Initialise box once overlay dimensions are known. Bias it upward so it sits
  // above the bottom sheet, keeping the map and box visible while choosing.
  // ---------------------------------------------------------------------------

  const initBox = useCallback((ow: number, oh: number) => {
    if (initialised.current || ow === 0 || oh === 0) return;
    initialised.current = true;
    const bw = ow * 0.62;
    const bh = oh * 0.44;
    const initial: Box = { x: (ow - bw) / 2, y: oh * 0.1, w: bw, h: bh };
    boxRef.current = initial;
    setBox(initial);
  }, []);

  // ---------------------------------------------------------------------------
  // Geometry recomputation — SYNCHRONOUS (toGeo reads cached map bounds), so the
  // estimate updates live on every box change, including mid-drag. The quality
  // (max zoom) and selected layers are applied synchronously below, so changing
  // them never needs to recompute the geometry.
  // ---------------------------------------------------------------------------

  const recomputeGeo = useCallback(
    (b: Box) => {
      const tl = toGeo({ x: b.x, y: b.y });
      const br = toGeo({ x: b.x + b.w, y: b.y + b.h });
      // Bounds/layout not ready — keep the previous geometry.
      if (tl === null || br === null) return;
      const [lng0, lat0] = tl;
      const [lng1, lat1] = br;
      const bbox: BoundingBox = {
        minLat: Math.min(lat0, lat1),
        maxLat: Math.max(lat0, lat1),
        minLng: Math.min(lng0, lng1),
        maxLng: Math.max(lng0, lng1),
      };
      setGeo({ bbox, minZoom: overviewZoomFor(bbox) });
    },
    [toGeo],
  );

  // A stable ref so the once-memoised PanResponders always call the latest version.
  const recomputeCallbackRef = useRef(recomputeGeo);
  useEffect(() => {
    recomputeCallbackRef.current = recomputeGeo;
  }, [recomputeGeo]);

  // Recompute geometry whenever the box changes (including the initial box) — fires
  // on every drag move, so the estimate tracks the box live — AND whenever the map's
  // bounds change under it: the entry flatten settles asynchronously, so the very
  // first bounds are only trustworthy once the camera is flat and north-up.
  useEffect(() => {
    if (box.w > 0) recomputeCallbackRef.current(box);
  }, [box, boundsVersion]);

  // If the bounds cache wasn't ready when the overlay opened, keep retrying until
  // the first estimate lands (then stop).
  useEffect(() => {
    if (geo !== null || box.w === 0) return;
    const id = setInterval(() => recomputeCallbackRef.current(boxRef.current), 150);
    return () => clearInterval(id);
  }, [geo, box.w]);

  // ---------------------------------------------------------------------------
  // Derived estimate — geometry × quality × selected layers (all synchronous).
  // ---------------------------------------------------------------------------

  const maxZoom = QUALITY_ZOOM[quality];
  const selectedBasemaps = useMemo(
    () => LAYERS.map((l) => l.key).filter((k) => selected[k]),
    [selected],
  );
  // Every basemap's tile source tops out at its own zoom, so each is estimated
  // over the range it will really store (relief stops at z15).
  const estimate = geo
    ? estimateRegionDownload(geo.bbox, geo.minZoom, maxZoom, selectedBasemaps)
    : { tiles: 0, bytes: 0 };
  const totalTiles = estimate.tiles;
  const totalBytes = estimate.bytes;
  // Basemaps whose source can't reach the chosen quality — worth saying out loud,
  // otherwise "Max" quality silently downloads a coarser relief layer.
  const cappedLayers = LAYERS.filter(
    (l) => selected[l.key] && NATIVE_MAX_ZOOM[l.key] < maxZoom,
  ).map((l) => l.label);
  const noneSelected = selectedBasemaps.length === 0;
  const tooLarge = totalTiles > MAX_TILES;
  const canDownload = geo !== null && !noneSelected && !tooLarge;
  // When the box is too large at this quality, offer the highest quality that
  // fits as a one-tap fix — "Too large" alone made people shrink the box when
  // one notch coarser usually covers the same area (4× fewer tiles per notch).
  const fittingQuality =
    tooLarge && geo && !noneSelected
      ? QUALITY_BUTTONS.map((b) => b.value)
          .filter((q) => QUALITY_ZOOM[q] < maxZoom)
          .reverse()
          .find(
            (q) =>
              estimateRegionDownload(geo.bbox, geo.minZoom, QUALITY_ZOOM[q], selectedBasemaps)
                .tiles <= MAX_TILES,
          )
      : undefined;

  const toggleLayer = useCallback((key: Basemap) => {
    setSelected((s) => ({ ...s, [key]: !s[key] }));
  }, []);

  // ---------------------------------------------------------------------------
  // PanResponders — one per corner. Refs are read on touch events only.
  // ---------------------------------------------------------------------------

  const panTL = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs
      PanResponder.create({
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderGrant: () => {
          startBox.current = { ...boxRef.current };
        },
        onPanResponderMove: (_e, g) => {
          const { x: sx, y: sy, w: sw, h: sh } = startBox.current;
          const { w: ow, h: oh } = overlaySize.current;
          let x = Math.min(sx + g.dx, sx + sw - MIN_BOX);
          let y = Math.min(sy + g.dy, sy + sh - MIN_BOX);
          x = Math.max(0, x);
          y = Math.max(0, y);
          let w = sw - (x - sx);
          let h = sh - (y - sy);
          if (x + w > ow) w = ow - x;
          if (y + h > oh) h = oh - y;
          if (w < MIN_BOX) w = MIN_BOX;
          if (h < MIN_BOX) h = MIN_BOX;
          const next: Box = { x, y, w, h };
          boxRef.current = next;
          setBox(next);
        },
        onPanResponderRelease: () => {
          recomputeCallbackRef.current(boxRef.current);
        },
      }),
    [],
  );

  const panTR = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs
      PanResponder.create({
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderGrant: () => {
          startBox.current = { ...boxRef.current };
        },
        onPanResponderMove: (_e, g) => {
          const { x: sx, y: sy, w: sw, h: sh } = startBox.current;
          const { w: ow, h: oh } = overlaySize.current;
          let y = Math.min(sy + g.dy, sy + sh - MIN_BOX);
          y = Math.max(0, y);
          let w = Math.max(sw + g.dx, MIN_BOX);
          let h = sh - (y - sy);
          if (sx + w > ow) w = ow - sx;
          if (y + h > oh) h = oh - y;
          if (w < MIN_BOX) w = MIN_BOX;
          if (h < MIN_BOX) h = MIN_BOX;
          const next: Box = { x: sx, y, w, h };
          boxRef.current = next;
          setBox(next);
        },
        onPanResponderRelease: () => {
          recomputeCallbackRef.current(boxRef.current);
        },
      }),
    [],
  );

  const panBL = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs
      PanResponder.create({
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderGrant: () => {
          startBox.current = { ...boxRef.current };
        },
        onPanResponderMove: (_e, g) => {
          const { x: sx, y: sy, w: sw, h: sh } = startBox.current;
          const { w: ow, h: oh } = overlaySize.current;
          let x = Math.min(sx + g.dx, sx + sw - MIN_BOX);
          x = Math.max(0, x);
          let w = sw - (x - sx);
          let h = Math.max(sh + g.dy, MIN_BOX);
          if (x + w > ow) w = ow - x;
          if (sy + h > oh) h = oh - sy;
          if (w < MIN_BOX) w = MIN_BOX;
          if (h < MIN_BOX) h = MIN_BOX;
          const next: Box = { x, y: sy, w, h };
          boxRef.current = next;
          setBox(next);
        },
        onPanResponderRelease: () => {
          recomputeCallbackRef.current(boxRef.current);
        },
      }),
    [],
  );

  const panBR = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs
      PanResponder.create({
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderGrant: () => {
          startBox.current = { ...boxRef.current };
        },
        onPanResponderMove: (_e, g) => {
          const { x: sx, y: sy, w: sw, h: sh } = startBox.current;
          const { w: ow, h: oh } = overlaySize.current;
          let w = Math.max(sw + g.dx, MIN_BOX);
          let h = Math.max(sh + g.dy, MIN_BOX);
          if (sx + w > ow) w = ow - sx;
          if (sy + h > oh) h = oh - sy;
          if (w < MIN_BOX) w = MIN_BOX;
          if (h < MIN_BOX) h = MIN_BOX;
          const next: Box = { x: sx, y: sy, w, h };
          boxRef.current = next;
          setBox(next);
        },
        onPanResponderRelease: () => {
          recomputeCallbackRef.current(boxRef.current);
        },
      }),
    [],
  );

  // ---------------------------------------------------------------------------
  // Confirm.
  // ---------------------------------------------------------------------------

  const handleConfirm = useCallback(() => {
    // makeMap mode confirms the box alone — layers/quality/cap are the
    // download sheet's concerns.
    if (makeMapMode) {
      if (geo) onConfirm({ ...boxRef.current }, [], 0);
      return;
    }
    if (!geo || noneSelected || tooLarge) return;
    // Hand back the SCREEN rect: the owner converts it against freshly-read map
    // bounds so the downloaded area is exactly the drawn one.
    onConfirm({ ...boxRef.current }, selectedBasemaps, maxZoom);
  }, [geo, noneSelected, tooLarge, onConfirm, selectedBasemaps, maxZoom, makeMapMode]);

  // ---------------------------------------------------------------------------
  // Render.
  // ---------------------------------------------------------------------------

  const summary = noneSelected
    ? 'Select at least one layer'
    : tooLarge
      ? fittingQuality
        ? `Too large at ${QUALITY_BUTTONS.find((b) => b.value === quality)?.label} quality`
        : 'Too large — shrink the box'
      : geo === null
        ? 'Calculating…'
        : `≈ ${totalTiles.toLocaleString()} tiles · ${formatBytes(totalBytes)}`;

  // e.g. "Relief tops out at z15" — the layer downloads, just not that deep.
  const capNote =
    cappedLayers.length > 0 && !noneSelected
      ? `${cappedLayers.join(' & ')} tops out at z${Math.min(
          ...LAYERS.filter((l) => cappedLayers.includes(l.label)).map(
            (l) => NATIVE_MAX_ZOOM[l.key],
          ),
        )}`
      : null;

  return (
    <View
      style={styles.overlay}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        overlaySize.current = { w: width, h: height };
        initBox(width, height);
      }}
      pointerEvents="box-none"
    >
      {/* Dimmed areas outside the selection box */}
      {box.w > 0 && box.h > 0 && (
        <>
          <View
            style={[styles.dim, { top: 0, left: 0, right: 0, height: box.y }]}
            pointerEvents="none"
          />
          <View
            style={[styles.dim, { top: box.y + box.h, left: 0, right: 0, bottom: 0 }]}
            pointerEvents="none"
          />
          <View
            style={[styles.dim, { top: box.y, left: 0, width: box.x, height: box.h }]}
            pointerEvents="none"
          />
          <View
            style={[styles.dim, { top: box.y, left: box.x + box.w, right: 0, height: box.h }]}
            pointerEvents="none"
          />

          <View
            style={[
              styles.selectionBorder,
              { left: box.x, top: box.y, width: box.w, height: box.h },
            ]}
            pointerEvents="none"
          />

          <View
            style={[styles.handle, { left: box.x - HANDLE_SIZE / 2, top: box.y - HANDLE_SIZE / 2 }]}
            {...panTL.panHandlers}
          >
            <View style={[styles.handleDot, { backgroundColor: theme.colors.primary }]} />
          </View>
          <View
            style={[
              styles.handle,
              { left: box.x + box.w - HANDLE_SIZE / 2, top: box.y - HANDLE_SIZE / 2 },
            ]}
            {...panTR.panHandlers}
          >
            <View style={[styles.handleDot, { backgroundColor: theme.colors.primary }]} />
          </View>
          <View
            style={[
              styles.handle,
              { left: box.x - HANDLE_SIZE / 2, top: box.y + box.h - HANDLE_SIZE / 2 },
            ]}
            {...panBL.panHandlers}
          >
            <View style={[styles.handleDot, { backgroundColor: theme.colors.primary }]} />
          </View>
          <View
            style={[
              styles.handle,
              { left: box.x + box.w - HANDLE_SIZE / 2, top: box.y + box.h - HANDLE_SIZE / 2 },
            ]}
            {...panBR.panHandlers}
          >
            <View style={[styles.handleDot, { backgroundColor: theme.colors.primary }]} />
          </View>
        </>
      )}

      {/* Compact bottom sheet */}
      <Surface style={styles.sheet} elevation={4}>
        <Text variant="titleSmall" style={styles.title}>
          {makeMapMode ? 'Make a map — choose the area' : 'Download offline area'}
        </Text>

        {/* Layer pickers with live previews */}
        {makeMapMode ? null : (
          <View style={styles.layersRow}>
            {LAYERS.map((layer) => {
              const on = selected[layer.key];
              return (
                <Pressable
                  key={layer.key}
                  onPress={() => toggleLayer(layer.key)}
                  style={styles.layer}
                >
                  <View>
                    <RegionPreviewThumb
                      bbox={geo?.bbox ?? null}
                      basemap={layer.key}
                      tileUrl={tileUrl}
                      size={THUMB}
                    />
                    <View
                      style={[
                        styles.check,
                        {
                          backgroundColor: on ? theme.colors.primary : 'rgba(0,0,0,0.35)',
                          borderColor: theme.colors.surface,
                        },
                      ]}
                    >
                      {on && <Icon source="check" size={14} color={theme.colors.onPrimary} />}
                    </View>
                    {on && (
                      <View
                        style={[styles.selectedRing, { borderColor: theme.colors.primary }]}
                        pointerEvents="none"
                      />
                    )}
                  </View>
                  <Text variant="labelSmall" style={styles.layerLabel}>
                    {layer.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}

        {/* Quality */}
        {makeMapMode ? null : (
          <SegmentedButtons
            value={quality}
            onValueChange={(v) => setQuality(v as Quality)}
            density="small"
            buttons={QUALITY_BUTTONS}
            style={styles.quality}
          />
        )}

        {/* Estimate + actions */}
        {makeMapMode ? null : (
          <Text variant="bodyMedium" style={styles.summary}>
            {summary}
          </Text>
        )}
        {!makeMapMode && fittingQuality !== undefined && (
          <Button
            mode="contained-tonal"
            compact
            onPress={() => setQuality(fittingQuality)}
            style={styles.fitQualityBtn}
          >
            {`Use ${QUALITY_BUTTONS.find((b) => b.value === fittingQuality)?.label} quality instead`}
          </Button>
        )}
        {!makeMapMode && capNote !== null && (
          <Text
            variant="labelSmall"
            style={[styles.summary, { color: theme.colors.onSurfaceVariant }]}
          >
            {capNote}
          </Text>
        )}
        <View style={styles.actions}>
          <Button mode="outlined" onPress={onCancel} style={styles.actionBtn}>
            Cancel
          </Button>
          <Button
            mode="contained"
            onPress={handleConfirm}
            disabled={makeMapMode ? geo === null : !canDownload}
            style={styles.actionBtn}
          >
            {makeMapMode ? 'Next' : 'Download'}
          </Button>
        </View>
      </Surface>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  dim: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.45)' },
  selectionBorder: { position: 'absolute', borderWidth: 2, borderColor: '#ffffff' },
  handle: {
    position: 'absolute',
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  handleDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: '#ffffff',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 14,
    gap: 8,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  title: { textAlign: 'center' },
  layersRow: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
  },
  layer: { alignItems: 'center', gap: 4 },
  check: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedRing: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 2,
    borderRadius: 8,
  },
  layerLabel: { textAlign: 'center' },
  quality: { marginTop: 2 },
  summary: { textAlign: 'center' },
  fitQualityBtn: { alignSelf: 'center' },
  actions: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  actionBtn: { minWidth: 120 },
});
