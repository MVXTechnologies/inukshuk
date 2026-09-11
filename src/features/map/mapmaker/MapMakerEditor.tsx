import {
  clampZoom,
  metersPerPixel,
  scaleDenomForZoom,
  sharpestScaleDenom,
  zoomForGroundSpan,
} from '@core/mapmaker/cameraFit';
import {
  BOTTOM_STRIP_PT,
  coverageBbox,
  coverageMeters,
  MARGIN_PT,
  pageGeometry,
  SCALE_LADDER,
  type PageOrientation,
} from '@core/mapmaker/pageSpec';
import {
  DEFAULT_PRINT_STYLE,
  EDITOR_RASTER_TILE_SIZE,
  PRINT_STYLES,
  printStyleById,
  styleMaxSourceZoom,
  type PrintStyleId,
} from '@core/mapmaker/printSources';
import type { BoundingBox } from '@core/models';
import { useSettingsStore } from '@state/settingsStore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Button, ProgressBar, Text, TextInput, useTheme } from 'react-native-paper';
import type { ComposePhase, MakeMapOptions } from './composeMapPdf';

/**
 * The map maker as an editor (#349).
 *
 * The sheet is a fixed rectangle on screen and the LIVE map moves underneath
 * it — no composed raster, no debounce, no waiting. What lands inside the
 * frame is what prints, because the map is showing the very tile source the
 * composer will stitch (see `printSources`) and the frame's ground coverage is
 * derived from the page and scale the user chose.
 *
 * The camera is the single source of truth for scale: a scale chip sets the
 * zoom that makes the frame show that rung's coverage, and a pinch moves
 * continuously between rungs. Nothing fights the user.
 *
 * Inline views only — never Portal/Dialog (paper-portal-touch-swallow) and
 * never a Paper Surface for the panels (paper-surface-ios-flex-collapse).
 */

export type MakeMapProgress = { phase: ComposePhase; frac: number };

export interface EditorCamera {
  center: [number, number];
  zoom: number;
}

interface Props {
  /** Live camera, re-read whenever the map settles. */
  camera: EditorCamera | null;
  /** Non-null while composing. */
  progress: MakeMapProgress | null;
  /** Drive the map camera to a zoom (scale chips). */
  onRequestZoom: (zoom: number) => void;
  /** Tell the host which tile source to render, so preview === print. */
  onStyleChange: (style: PrintStyleId) => void;
  onCreate: (bbox: BoundingBox, options: MakeMapOptions, scaleDenom: number) => void;
  onCancel: () => void;
}

const PHASE_LABEL: Record<ComposePhase, string> = {
  tiles: 'Fetching map tiles…',
  terrain: 'Analysing terrain…',
  compose: 'Composing the PDF…',
};
const PHASE_BASE: Record<ComposePhase, number> = { tiles: 0, terrain: 1 / 3, compose: 2 / 3 };

const fmtScale = (d: number) => `1:${Math.round(d).toLocaleString('en-US').replace(/,/g, ' ')}`;
const fmtKm = (m: number) =>
  m >= 1000 ? `${(m / 1000).toFixed(m < 10000 ? 1 : 0)}` : `${Math.round(m)} m`;
const fmtCoverage = (w: number, h: number) =>
  w >= 1000 && h >= 1000 ? `${fmtKm(w)} × ${fmtKm(h)} km` : `${Math.round(w)} × ${Math.round(h)} m`;

export function MapMakerEditor({
  camera,
  progress,
  onRequestZoom,
  onStyleChange,
  onCreate,
  onCancel,
}: Props) {
  const theme = useTheme();
  const [preset, setPreset] = useState<'a4' | 'letter'>('a4');
  const [orientation, setOrientation] = useState<PageOrientation>('portrait');
  const [style, setStyle] = useState<PrintStyleId>(DEFAULT_PRINT_STYLE);
  const [collapsed, setCollapsed] = useState(false);
  // Dated default, as before — the region's own name lands with the content
  // picker (resolveRegionName already exists; the map maker never called it).
  const [name, setName] = useState(() => `My map ${new Date().toISOString().slice(0, 10)}`);
  const [stage, setStage] = useState({ width: 0, height: 0 });

  // The host renders the print tile source for as long as we are open.
  useEffect(() => {
    onStyleChange(style);
  }, [style, onStyleChange]);

  const geometry = useMemo(() => pageGeometry({ preset, orientation }), [preset, orientation]);

  // --- the sheet, sized to the stage ---------------------------------------
  const sheet = useMemo(() => {
    const { page } = geometry;
    const aspect = page.widthPt / page.heightPt;
    const availH = Math.max(0, stage.height - 16);
    const availW = Math.max(0, stage.width - 32);
    if (availH <= 0 || availW <= 0) return { w: 0, h: 0, winW: 0, winH: 0 };
    let h = availH;
    let w = h * aspect;
    if (w > availW) {
      w = availW;
      h = w / aspect;
    }
    return {
      w,
      h,
      // The window is the map frame: the sheet minus its margins.
      winW: w * (geometry.mapRect.w / page.widthPt),
      winH: h * (geometry.mapRect.h / page.heightPt),
    };
  }, [geometry, stage]);

  // --- what the frame is showing, straight off the camera ------------------
  const live = useMemo(() => {
    if (!camera || sheet.winW <= 0) return null;
    const lat = camera.center[1];
    const mpp = metersPerPixel(camera.zoom, lat);
    const widthM = mpp * sheet.winW;
    const heightM = mpp * sheet.winH;
    return {
      bbox: coverageBbox(camera.center, { widthM, heightM }),
      widthM,
      heightM,
      // Derived, not chosen: the camera IS the scale.
      scaleDenom: scaleDenomForZoom(camera.zoom, sheet.winW, lat, geometry.mapRect.w),
    };
  }, [camera, sheet.winW, sheet.winH, geometry.mapRect.w]);

  /**
   * Past this scale the chosen source has no more real tiles and the sheet is
   * showing overscaled ones. Imagery (z17) runs out two levels before street
   * (z19), which looks like a rendering fault unless we say so.
   */
  const softBelow = useMemo(() => {
    if (!camera || sheet.winW <= 0) return null;
    const limit = sharpestScaleDenom(
      styleMaxSourceZoom(printStyleById(style)),
      EDITOR_RASTER_TILE_SIZE,
      sheet.winW,
      camera.center[1],
      geometry.mapRect.w,
    );
    return limit > 0 ? limit : null;
  }, [camera, sheet.winW, style, geometry.mapRect.w]);

  const overscaled = live !== null && softBelow !== null && live.scaleDenom < softBelow;

  // Tapping a rung drives the camera to the zoom that shows its coverage.
  const goToScale = useCallback(
    (denom: number) => {
      if (!camera || sheet.winW <= 0) return;
      const cov = coverageMeters(geometry, denom);
      onRequestZoom(clampZoom(zoomForGroundSpan(cov.widthM, sheet.winW, camera.center[1])));
    },
    [camera, sheet.winW, geometry, onRequestZoom],
  );

  // Changing page or orientation must not change the ground the sheet shows —
  // only its shape. Re-pin the camera to the scale that was on screen.
  const lastScaleRef = useRef<number | null>(null);
  useEffect(() => {
    if (live) lastScaleRef.current = live.scaleDenom;
  }, [live]);
  const firstShape = useRef(true);
  useEffect(() => {
    if (firstShape.current) {
      firstShape.current = false;
      return;
    }
    if (lastScaleRef.current !== null) goToScale(lastScaleRef.current);
    // Re-pin on shape changes only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, orientation]);

  const contourIntervalM = useSettingsStore((s) => s.terrainContourIntervalM);
  const slopeMinDeg = useSettingsStore((s) => s.terrainSlopeMinDeg);
  const slopeMaxDeg = useSettingsStore((s) => s.terrainSlopeMaxDeg);
  const buildOptions = useCallback((): MakeMapOptions => {
    const s = printStyleById(style);
    return {
      name: name.trim() || 'My map',
      format: preset,
      basemap: s.drape,
      contours: true,
      contourIntervalM,
      slope: false,
      slopeMinDeg,
      slopeMaxDeg,
      slopeOpacity: 0.55,
      includeUserData: true,
      markedTrailsNetworks: [],
      markedTrailsOpacity: 0.85,
      grid: true,
      compass: true,
      declinationDeg: null,
    };
  }, [name, preset, style, contourIntervalM, slopeMinDeg, slopeMaxDeg]);

  // ---------------------------------------------------------------- compose
  if (progress) {
    const value = PHASE_BASE[progress.phase] + progress.frac / 3;
    return (
      <View style={styles.fill} pointerEvents="box-none">
        <View
          style={[
            styles.progressCard,
            { backgroundColor: theme.colors.elevation?.level3 ?? theme.colors.surface },
          ]}
        >
          <Text variant="titleSmall" style={styles.centerText}>
            Making “{name.trim() || 'My map'}”
          </Text>
          <Text variant="bodySmall" style={styles.centerText}>
            {PHASE_LABEL[progress.phase]}
          </Text>
          <ProgressBar progress={value} style={styles.bar} />
          <Button mode="outlined" onPress={onCancel} style={styles.cancelWide}>
            Cancel
          </Button>
        </View>
      </View>
    );
  }

  const scrim = theme.dark ? 'rgba(4,6,3,0.62)' : 'rgba(30,27,20,0.55)';
  const surface = theme.colors.elevation?.level2 ?? theme.colors.surface;
  const activeScale = live ? live.scaleDenom : 0;

  const chip = (
    label: string,
    sub: string | null,
    active: boolean,
    onPress: () => void,
    key: string,
  ) => (
    <Pressable
      key={key}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[
        styles.chip,
        {
          borderColor: active ? 'transparent' : theme.colors.outline,
          backgroundColor: active ? theme.colors.primaryContainer : 'transparent',
        },
      ]}
    >
      <Text
        variant="labelMedium"
        style={{ color: active ? theme.colors.onPrimaryContainer : theme.colors.onSurfaceVariant }}
      >
        {label}
      </Text>
      {sub ? (
        <Text
          variant="labelSmall"
          style={[
            styles.chipSub,
            { color: active ? theme.colors.onPrimaryContainer : theme.colors.onSurfaceVariant },
          ]}
        >
          {sub}
        </Text>
      ) : null}
    </Pressable>
  );

  return (
    <View style={styles.fill} pointerEvents="box-none" testID="make-map-editor">
      {/* The stage: the sheet sits here, the live map shows through its window. */}
      <View
        style={styles.stage}
        pointerEvents="box-none"
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setStage((p) => (p.width === width && p.height === height ? p : { width, height }));
        }}
      >
        {sheet.w > 0 && (
          <View style={{ width: sheet.w, height: sheet.h }} pointerEvents="none">
            {/* Four paper bands around a transparent window. A white sheet with
                a transparent child is still a white sheet — the parent paints
                behind it — so the map would never show through. */}
            <Band
              style={{
                left: 0,
                right: 0,
                top: 0,
                height: sheet.h * (MARGIN_PT / geometry.page.heightPt),
              }}
            />
            <Band
              style={{
                left: 0,
                right: 0,
                bottom: 0,
                height: sheet.h * (BOTTOM_STRIP_PT / geometry.page.heightPt),
              }}
            />
            <Band
              style={{
                left: 0,
                width: sheet.w * (MARGIN_PT / geometry.page.widthPt),
                top: sheet.h * (MARGIN_PT / geometry.page.heightPt),
                bottom: sheet.h * (BOTTOM_STRIP_PT / geometry.page.heightPt),
              }}
            />
            <Band
              style={{
                right: 0,
                width: sheet.w * (MARGIN_PT / geometry.page.widthPt),
                top: sheet.h * (MARGIN_PT / geometry.page.heightPt),
                bottom: sheet.h * (BOTTOM_STRIP_PT / geometry.page.heightPt),
              }}
            />
            {/* The neatline, drawn on the window's edge. */}
            <View
              style={[
                styles.neatline,
                {
                  left: sheet.w * (MARGIN_PT / geometry.page.widthPt),
                  right: sheet.w * (MARGIN_PT / geometry.page.widthPt),
                  top: sheet.h * (MARGIN_PT / geometry.page.heightPt),
                  bottom: sheet.h * (BOTTOM_STRIP_PT / geometry.page.heightPt),
                },
              ]}
            />
            {/* The printed strip, at its true proportion of the page. */}
            <View
              style={[
                styles.strip,
                {
                  height: sheet.h * (BOTTOM_STRIP_PT / geometry.page.heightPt),
                  paddingHorizontal: sheet.w * (MARGIN_PT / geometry.page.widthPt),
                },
              ]}
            >
              <Text numberOfLines={1} style={styles.stripTitle}>
                {name.trim() || 'My map'}
              </Text>
              <Text style={styles.stripScale}>{live ? fmtScale(live.scaleDenom) : ''}</Text>
            </View>
          </View>
        )}

        {/* The mask: four scrims around the sheet, so the page is the subject. */}
        {sheet.w > 0 && <Mask stage={stage} sheet={sheet} color={scrim} />}

        {/* Readout — and, collapsed, the way back. */}
        <Pressable
          testID="make-map-readout"
          onPress={() => collapsed && setCollapsed(false)}
          accessibilityRole={collapsed ? 'button' : 'text'}
          accessibilityLabel={collapsed ? 'Show map maker options' : undefined}
          style={styles.readout}
        >
          <Text style={styles.readoutLine}>
            {live
              ? `${fmtScale(live.scaleDenom)}  ·  ${fmtCoverage(live.widthM, live.heightM)}`
              : 'Positioning…'}
          </Text>
          {collapsed ? <Text style={styles.readoutHint}>▲ tap for options</Text> : null}
        </Pressable>
      </View>

      {/* The drawer. Collapsed, it is gone and the map runs full bleed. */}
      {!collapsed && (
        <View style={[styles.drawer, { backgroundColor: surface }]}>
          <Pressable
            testID="make-map-collapse"
            onPress={() => setCollapsed(true)}
            accessibilityRole="button"
            accessibilityLabel="Hide map maker options"
            style={styles.grabHit}
          >
            <View style={[styles.grab, { backgroundColor: theme.colors.outline }]} />
          </Pressable>

          <TextInput
            mode="outlined"
            dense
            label="Map name"
            defaultValue={name}
            onChangeText={setName}
            placeholder="My map"
            // #235 — Return is the only iOS way out of this field.
            returnKeyType="done"
            blurOnSubmit
            onSubmitEditing={() => Keyboard.dismiss()}
            style={styles.name}
          />

          <Text
            variant="labelSmall"
            style={[styles.groupLabel, { color: theme.colors.onSurfaceVariant }]}
          >
            Scale — pinch the map to go between rungs
          </Text>
          <View style={styles.chipRow}>
            {SCALE_LADDER.map((d) => {
              const cov = coverageMeters(geometry, d);
              const active = activeScale > 0 && Math.abs(Math.log(activeScale / d)) < 0.06;
              return chip(
                `1:${d / 1000}k`,
                fmtCoverage(cov.widthM, cov.heightM),
                active,
                () => goToScale(d),
                `s${d}`,
              );
            })}
          </View>

          <Text
            variant="labelSmall"
            style={[styles.groupLabel, { color: theme.colors.onSurfaceVariant }]}
          >
            Page
          </Text>
          <View style={styles.chipRow}>
            {chip('A4', null, preset === 'a4', () => setPreset('a4'), 'a4')}
            {chip('Letter', null, preset === 'letter', () => setPreset('letter'), 'lt')}
            {chip(
              'Portrait',
              null,
              orientation === 'portrait',
              () => setOrientation('portrait'),
              'po',
            )}
            {chip(
              'Landscape',
              null,
              orientation === 'landscape',
              () => setOrientation('landscape'),
              'la',
            )}
          </View>

          <Text
            variant="labelSmall"
            style={[styles.groupLabel, { color: theme.colors.onSurfaceVariant }]}
          >
            Style — what you see is what prints
          </Text>
          <View style={styles.chipRow}>
            {PRINT_STYLES.map((s) =>
              chip(s.label, null, style === s.id, () => setStyle(s.id), s.id),
            )}
          </View>
          {overscaled && softBelow !== null ? (
            <Text
              variant="labelSmall"
              testID="make-map-detail-limit"
              style={[styles.limitNote, { color: theme.colors.onSurfaceVariant }]}
            >
              {printStyleById(style).label} has no more detail past {fmtScale(softBelow)} — the
              sheet is enlarging the tiles it has.
            </Text>
          ) : null}

          <View style={styles.actions}>
            <Button
              mode="outlined"
              testID="make-map-cancel"
              onPress={onCancel}
              style={styles.actionBtn}
            >
              Cancel
            </Button>
            <Button
              mode="contained"
              testID="make-map-create"
              style={styles.actionBtn}
              disabled={!live}
              onPress={() => live && onCreate(live.bbox, buildOptions(), live.scaleDenom)}
            >
              Create
            </Button>
          </View>
        </View>
      )}

      {/* Collapsed: Cancel and Create detach so look-then-commit never needs
          the panels back. */}
      {collapsed && (
        <View style={styles.floatRow} pointerEvents="box-none">
          <Button mode="contained-tonal" compact onPress={onCancel}>
            Cancel
          </Button>
          <Button
            mode="contained"
            compact
            disabled={!live}
            onPress={() => live && onCreate(live.bbox, buildOptions(), live.scaleDenom)}
          >
            Create
          </Button>
        </View>
      )}
    </View>
  );
}

const Band = ({ style }: { style: ViewStyle }) => <View style={[styles.band, style]} />;

/**
 * Four scrims around the sheet. RN has no "cut a hole in this view", and the
 * web trick of a huge box-shadow spread does not exist here either, so the
 * surround is drawn as four rectangles around the centred sheet.
 */
function Mask({
  stage,
  sheet,
  color,
}: {
  stage: { width: number; height: number };
  sheet: { w: number; h: number };
  color: string;
}) {
  const sideW = Math.max(0, (stage.width - sheet.w) / 2);
  const capH = Math.max(0, (stage.height - sheet.h) / 2);
  const bg = { backgroundColor: color };
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[bg, { position: 'absolute', left: 0, right: 0, top: 0, height: capH }]} />
      <View style={[bg, { position: 'absolute', left: 0, right: 0, bottom: 0, height: capH }]} />
      <View
        style={[bg, { position: 'absolute', left: 0, top: capH, width: sideW, height: sheet.h }]}
      />
      <View
        style={[bg, { position: 'absolute', right: 0, top: capH, width: sideW, height: sheet.h }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill, zIndex: 10 },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  band: { position: 'absolute', backgroundColor: '#FDFCF9' },
  neatline: { position: 'absolute', borderWidth: StyleSheet.hairlineWidth, borderColor: '#1A1A1A' },
  strip: { position: 'absolute', left: 0, right: 0, bottom: 0, justifyContent: 'center', gap: 1 },
  stripTitle: { color: '#1A1A1A', fontWeight: '700', fontSize: 11 },
  stripScale: { color: '#4A4A4A', fontSize: 9 },
  readout: {
    position: 'absolute',
    bottom: 8,
    alignSelf: 'center',
    backgroundColor: 'rgba(18,21,15,0.74)',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 10,
    alignItems: 'center',
  },
  readoutLine: { color: '#F0EDE4', fontSize: 11.5, fontVariant: ['tabular-nums'] },
  readoutHint: { color: '#B6C98A', fontSize: 10 },
  drawer: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 14,
    paddingBottom: 12,
    gap: 6,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: -4 },
  },
  grabHit: { alignSelf: 'stretch', alignItems: 'center', paddingVertical: 8 },
  grab: { width: 36, height: 4, borderRadius: 2, opacity: 0.55 },
  name: { marginBottom: 2 },
  groupLabel: { marginTop: 4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 5 },
  chipSub: { opacity: 0.75, fontSize: 9.5 },
  limitNote: { opacity: 0.85, marginTop: 2 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 8 },
  actionBtn: { minWidth: 110 },
  floatRow: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  progressCard: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: 14,
    borderRadius: 16,
    padding: 16,
    gap: 6,
    elevation: 6,
  },
  centerText: { textAlign: 'center' },
  bar: { marginVertical: 10, height: 6, borderRadius: 3 },
  cancelWide: { alignSelf: 'center', minWidth: 140 },
});
