import { WEATHER_LAYERS, weatherLayerById, type WeatherLayerId } from '@core/geo/weatherLayers';
import { MARINE_LAYER_IDS } from '@core/geo/marineLayers';
import { MARINE_ENABLED, PARKED_LABEL, WEATHER_ENABLED } from '@core/features/flags';
import { radarAvailableAt } from '@core/weather/modelCoverage';
import {
  PEAK_DENSITIES,
  PEAK_DENSITY_LABEL,
  SHADING_LABEL,
  SHADING_LEVELS,
  type ShadingLevel,
} from '@core/map/terrainOptions';
import { TILT_RELIEF_LABEL, TILT_RELIEFS } from '@core/map/tiltRelief';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Icon, Text, TouchableRipple } from 'react-native-paper';
import {
  CONTOUR_INTERVALS,
  contourIntervalLabel,
  DisclaimerSnackbar,
  useSlopeDisclaimer,
} from '../terrain3d/overlayControls';
import { FolderPickerDialog } from './FolderPickerDialog';
import { MapButton } from './MapButton';
import {
  LevelsRow,
  MapSheet,
  NavRow,
  SectionTitle,
  Segmented,
  SheetHeader,
  SwitchRow,
  useSheetAccent,
  useSheetWidth,
} from './mapSheet';
import { RangeSlider } from './RangeSlider';

/**
 * THE overlays menu (#484 redesign): everything drawn on top of the base map,
 * as ONE themed, scrolling sheet in the Map type panel's visual language —
 * section titles, icon + label + one-line hint rows, Switches instead of
 * checkboxes, segmented pickers where a row has levels. It replaces the
 * D-6 drill-down (top-level groups → Topology sub-menu on a fixed dark slab):
 *
 * - On the map — Content (folder picker), PDF maps, Personal heatmap,
 *   Labels on satellite.
 * - Terrain — Shading, 3D relief, Contours (+ density), Slope (+ range),
 *   Peaks, Elevation tint (3D only).
 * - Live layers — Weather (drills into its list) and Marine, both parked
 *   this release (greyed "Coming soon", never removed: a feature that
 *   silently disappears reads as a bug).
 *
 * Every setting it drives is the one the old rows drove, with the same
 * semantics (Shading None = hillshade off; a level turns it on at that
 * strength; 3D relief rests with Shading None).
 *
 * A11y/Maestro contract: the opener keeps the EXACT label 'Map overlays';
 * the sheet's ✕ is 'Close overlays' — the open-state sentinel now that
 * 'Topology' is gone. Rows keep the labels the flows key on: 'Content: …',
 * 'PDF maps', 'Personal heatmap', 'Slope', 'Contours', the level names
 * ('Auto', '50 m', 'Heavy', …), 'Slope minimum/maximum', 'Weather'/
 * 'Weather: <layer>'/'Weather (coming soon)', 'Marine'/'Marine (coming
 * soon)'; the weather list's back row stays 'Back to overlays'.
 *
 * The rows scroll inside a capped height. The slope RangeSlider claims its
 * touches at touch-down and refuses termination, so a drag on a thumb beats
 * the ScrollView; the level pickers are taps.
 */

/** Per-layer icon (MaterialCommunityIcons). UI-only mapping — the catalog in
 * `@core/geo/weatherLayers` stays presentation-free. */
const WEATHER_LAYER_ICONS: Record<WeatherLayerId, string> = {
  'radar-rain': 'weather-pouring',
  'radar-snow': 'weather-snowy-heavy',
  temp: 'thermometer',
  wind: 'weather-windy',
  precip: 'weather-rainy',
};

/** Tallest the sheet's scrolling body gets, as a share of the window. */
const BODY_MAX_SHARE = 0.6;
/** The RangeSlider's value label + its gap, beside the track. */
const RANGE_VALUE_W = 74;
/** The `below` indent of a sheet row (see mapSheet), left + right. */
const BELOW_INSET = 52 + 16;

const SHADING = SHADING_LEVELS.map((l) => ({ value: l, label: SHADING_LABEL[l] }));
const TILT = TILT_RELIEFS.map((r) => ({ value: r, label: TILT_RELIEF_LABEL[r] }));
const PEAKS = PEAK_DENSITIES.map((d) => ({ value: d, label: PEAK_DENSITY_LABEL[d] }));
const CONTOUR_DENSITY = CONTOUR_INTERVALS.map((m) => ({
  value: m,
  label: contourIntervalLabel(m),
}));

/**
 * The overlay rows (everything but the sheet chrome). `onOpenWeather` drills
 * into the weather list.
 */
function OverlayRows({
  showHypso,
  onSlopeEnabled,
  onOpenFolders,
  onOpenWeather,
}: {
  showHypso: boolean;
  onSlopeEnabled: () => void;
  onOpenFolders: () => void;
  onOpenWeather: () => void;
}) {
  const { accent } = useSheetAccent();
  const tokens = useSchemeTokens();
  const sheetW = useSheetWidth();
  const basemap = useMapStore((s) => s.basemap);
  const mapVisibilityMode = useLibraryStore((s) => s.mapVisibilityMode);
  const visibleFolderIds = useLibraryStore((s) => s.visibleFolderIds);
  const offlineOnly = useSettingsStore((s) => s.offlineOnly);
  const weatherLayer = useSettingsStore((s) => s.weatherLayer);
  const marineLayers = useSettingsStore((s) => s.marineLayers);
  const slope = useSettingsStore((s) => s.terrainSlope);
  const contours = useSettingsStore((s) => s.terrainContours);
  const hypso = useSettingsStore((s) => s.terrainHypso);
  const intervalM = useSettingsStore((s) => s.terrainContourIntervalM);
  const slopeMinDeg = useSettingsStore((s) => s.terrainSlopeMinDeg);
  const slopeMaxDeg = useSettingsStore((s) => s.terrainSlopeMaxDeg);
  const showHeatmap = useSettingsStore((s) => s.showHeatmap);
  const showPdfMaps = useSettingsStore((s) => s.showPdfOverlay);
  const satelliteLabels = useSettingsStore((s) => s.satelliteLabels);
  const showHillshade = useSettingsStore((s) => s.showHillshade);
  const hillshadeStrength = useSettingsStore((s) => s.hillshadeStrength);
  const peakDensity = useSettingsStore((s) => s.peakDensity);
  const tiltRelief = useSettingsStore((s) => s.tiltRelief);
  const set = useSettingsStore((s) => s.set);

  // "None" is the hillshade switch off (#230 keeps its platform default);
  // any other level turns it on at that strength (#461).
  const shading: ShadingLevel = showHillshade ? hillshadeStrength : 'none';
  const setShading = (level: ShadingLevel) => {
    if (level === 'none') {
      set('showHillshade', false);
      return;
    }
    set('hillshadeStrength', level);
    set('showHillshade', true);
  };

  const typeMode = mapVisibilityMode === 'type';
  const contentTitle = typeMode
    ? 'Content: everything'
    : `Content: ${visibleFolderIds.length} folder${visibleFolderIds.length === 1 ? '' : 's'}`;

  // Only meaningful over imagery: on the Map base the row stays visible but
  // greyed, saying where it applies.
  const onSatellite = basemap === 'satellite';

  // Marine chart mode is all-or-nothing (D-6 amendment): on = every catalog
  // layer, off = none. While parked the persisted array is left ALONE but
  // reads as off, so the row never shows a mode the map is not drawing.
  const marineOn = MARINE_ENABLED && marineLayers.length > 0;
  const weatherName = weatherLayer !== null ? weatherLayerById(weatherLayer).label : null;

  return (
    <>
      <SectionTitle>On the map</SectionTitle>
      <NavRow
        icon={typeMode ? 'folder-multiple-outline' : 'folder-multiple'}
        label={contentTitle}
        hint="Which trails and maps are drawn"
        onPress={onOpenFolders}
      />
      {/* The "PDF maps" master switch (#233): the one way to clear the map of
          imported/made sheets whatever the Content picker says. */}
      <SwitchRow
        icon="map-legend"
        label="PDF maps"
        hint={showPdfMaps ? 'Your imported and made maps' : 'Hidden on the map'}
        value={showPdfMaps}
        onToggle={() => set('showPdfOverlay', !showPdfMaps)}
      />
      <SwitchRow
        icon="fire"
        label="Personal heatmap"
        hint="Where you have been, by visits"
        value={showHeatmap}
        onToggle={() => set('showHeatmap', !showHeatmap)}
      />
      <SwitchRow
        icon="label-outline"
        label="Labels on satellite"
        hint={onSatellite ? 'Trails and names over imagery' : 'For the Satellite map type'}
        value={satelliteLabels}
        disabled={!onSatellite}
        onToggle={() => set('satelliteLabels', !satelliteLabels)}
      />

      <SectionTitle>Terrain</SectionTitle>
      <LevelsRow
        icon="image-filter-hdr"
        label="Shading"
        levels={SHADING}
        selected={shading}
        onSelect={setShading}
      />
      {/* #480: how much that shading deepens when the map is tilted (two
          fingers). It deepens the hillshade, so it rests with Shading None. */}
      <LevelsRow
        icon="rotate-3d-variant"
        label="3D relief"
        hint={showHillshade ? 'When you tilt the map' : 'Needs shading'}
        levels={TILT}
        selected={tiltRelief}
        onSelect={(r) => set('tiltRelief', r)}
        disabled={!showHillshade}
      />
      <SwitchRow
        icon="vector-curve"
        label="Contours"
        value={contours}
        onToggle={() => set('terrainContours', !contours)}
        below={
          <Segmented
            levels={CONTOUR_DENSITY}
            selected={intervalM}
            onSelect={(m) => set('terrainContourIntervalM', m)}
            disabled={!contours}
          />
        }
      />
      <SwitchRow
        icon="angle-acute"
        label="Slope"
        hint="Steepness shading"
        value={slope}
        onToggle={() => {
          const next = !slope;
          set('terrainSlope', next);
          if (next) onSlopeEnabled();
        }}
        below={
          <RangeSlider
            min={0}
            max={90}
            width={sheetW - BELOW_INSET - RANGE_VALUE_W}
            lo={slopeMinDeg}
            hi={slopeMaxDeg}
            disabled={!slope}
            accessibilityLabel="Slope"
            onChange={(newLo, newHi) => {
              set('terrainSlopeMinDeg', newLo);
              set('terrainSlopeMaxDeg', newHi);
            }}
            accentColor={accent}
            trackColor={tokens.surfaceVariant}
          />
        }
      />
      <LevelsRow
        icon="triangle-outline"
        label="Peaks"
        hint="How early summits are named"
        levels={PEAKS}
        selected={peakDensity}
        onSelect={(d) => set('peakDensity', d)}
      />
      {showHypso && (
        <SwitchRow
          icon="palette-outline"
          label="Elevation tint"
          value={hypso}
          onToggle={() => set('terrainHypso', !hypso)}
        />
      )}

      <SectionTitle>Live layers</SectionTitle>
      {/* Parked (see `@core/features/flags`) outranks the offline-only hint:
          it is the permanent condition this release. Otherwise these are
          network-only: under "Locally downloaded only" the layers are dropped
          from the style, so the rows are disabled with a hint instead of
          pretending a pick would show anything. */}
      <NavRow
        icon="weather-partly-cloudy"
        label="Weather"
        hint={
          !WEATHER_ENABLED
            ? PARKED_LABEL
            : offlineOnly
              ? 'Needs connection'
              : (weatherName ?? 'Off')
        }
        accessibilityLabel={
          !WEATHER_ENABLED
            ? `Weather (${PARKED_LABEL.toLowerCase()})`
            : offlineOnly
              ? 'Weather (needs connection)'
              : weatherName !== null
                ? `Weather: ${weatherName}`
                : 'Weather'
        }
        disabled={!WEATHER_ENABLED || offlineOnly}
        onPress={onOpenWeather}
      />
      <SwitchRow
        icon="anchor"
        label="Marine"
        hint={!MARINE_ENABLED ? PARKED_LABEL : offlineOnly ? 'Needs connection' : 'Nautical chart'}
        accessibilityLabel={
          !MARINE_ENABLED
            ? `Marine (${PARKED_LABEL.toLowerCase()})`
            : offlineOnly
              ? 'Marine (needs connection)'
              : 'Marine'
        }
        value={marineOn}
        disabled={!MARINE_ENABLED || offlineOnly}
        onToggle={() => set('marineLayers', marineOn ? [] : [...MARINE_LAYER_IDS])}
      />
    </>
  );
}

/**
 * Weather list: None + the catalog, the selection ringed in the accent, the
 * honest "Canada only" hint on radar rows while the map centre sits outside
 * the North American composite.
 */
function WeatherList({ onBack }: { onBack: () => void }) {
  const tokens = useSchemeTokens();
  const { accent } = useSheetAccent();
  const weatherLayer = useSettingsStore((s) => s.weatherLayer);
  const set = useSettingsStore((s) => s.set);
  // Boolean selector, so the list only re-renders when the answer flips at
  // the coverage edge.
  const radarOutside = useMapStore((s) => !radarAvailableAt(s.mapCenter));

  const row = (id: WeatherLayerId | null, label: string, hint?: string) => {
    const selected = weatherLayer === id;
    return (
      <TouchableRipple
        key={id ?? 'none'}
        onPress={() => set('weatherLayer', id)}
        accessibilityLabel={label}
        accessibilityState={{ selected }}
        style={styles.weatherRow}
        borderless
      >
        <View style={styles.weatherRowInner}>
          <View
            style={[
              styles.disc,
              {
                backgroundColor: tokens.surfaceVariant,
                borderColor: selected ? accent : 'transparent',
              },
            ]}
          >
            <Icon
              source={id === null ? 'eye-off-outline' : WEATHER_LAYER_ICONS[id]}
              size={18}
              color={id === null ? tokens.inkMuted : tokens.ink}
            />
          </View>
          <View style={styles.weatherText}>
            <Text
              numberOfLines={1}
              style={[styles.weatherLabel, { color: tokens.ink }, selected && styles.bold]}
            >
              {label}
            </Text>
            {hint !== undefined && (
              <Text numberOfLines={1} style={[styles.weatherHint, { color: tokens.inkMuted }]}>
                {hint}
              </Text>
            )}
          </View>
          {selected && <Icon source="check" size={18} color={accent} />}
        </View>
      </TouchableRipple>
    );
  };

  return (
    <>
      <TouchableRipple
        onPress={onBack}
        accessibilityLabel="Back to overlays"
        style={styles.backRow}
        borderless
      >
        <View style={styles.backInner}>
          <Icon source="chevron-left" size={24} color={tokens.ink} />
          <Text style={[styles.backTitle, { color: tokens.ink }]}>Weather</Text>
        </View>
      </TouchableRipple>
      {row(null, 'None')}
      {WEATHER_LAYERS.map((l) =>
        row(l.id, l.label, l.timeline === 'past' && radarOutside ? 'Canada only' : undefined),
      )}
    </>
  );
}

/**
 * The sheet's content: title + ✕, then the scrolling rows (or the weather
 * list). Mounted only while the menu is open, so it always opens at the top.
 */
export function OverlaysPanel({
  showHypso,
  onSlopeEnabled,
  onOpenFolders,
  onClose,
}: {
  /** Show the 3D-only Elevation tint row (when the 3D view is active). */
  showHypso: boolean;
  onSlopeEnabled: () => void;
  onOpenFolders: () => void;
  onClose: () => void;
}) {
  const [weatherOpen, setWeatherOpen] = useState(false);
  const { height: windowH } = useWindowDimensions();
  return (
    <>
      <SheetHeader title="Overlays" closeLabel="Close overlays" onClose={onClose} />
      <ScrollView
        style={{ maxHeight: windowH * BODY_MAX_SHARE }}
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator
        keyboardShouldPersistTaps="handled"
      >
        {weatherOpen ? (
          <WeatherList onBack={() => setWeatherOpen(false)} />
        ) : (
          <OverlayRows
            showHypso={showHypso}
            onSlopeEnabled={onSlopeEnabled}
            onOpenFolders={onOpenFolders}
            onOpenWeather={() => setWeatherOpen(true)}
          />
        )}
      </ScrollView>
    </>
  );
}

/** The dialogs the sheet launches, hosted once by the rail. */
export function OverlaysDialogs({
  foldersOpen,
  onFoldersDismiss,
  snackbar,
}: {
  foldersOpen: boolean;
  onFoldersDismiss: () => void;
  snackbar: ReturnType<typeof useSlopeDisclaimer>['snackbar'];
}) {
  return (
    <>
      <FolderPickerDialog visible={foldersOpen} onDismiss={onFoldersDismiss} />
      <DisclaimerSnackbar snackbar={snackbar} />
    </>
  );
}

/**
 * The overlays button + the sheet unfolding beneath it in the rail's own
 * column (the MapActionsMenu idiom). `open` is owned by the rail so it can
 * drop the map-covering backdrop that closes the sheet on an outside tap.
 * `hideTrigger` lets the rail draw the button itself, joined with Base map in
 * one pill (revamp `Main.html`); the sheet and dialogs still live here.
 */
export function MapOverlaysMenu({
  showHypso = false,
  open,
  onToggle,
  hideTrigger = false,
}: {
  showHypso?: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const [foldersOpen, setFoldersOpen] = useState(false);
  const { snackbar, onSlopeEnabled } = useSlopeDisclaimer();

  return (
    <>
      {!hideTrigger && (
        <MapButton
          icon="gradient-vertical"
          onPress={() => onToggle(!open)}
          accessibilityLabel="Map overlays"
        />
      )}
      {open && (
        <MapSheet>
          <OverlaysPanel
            showHypso={showHypso}
            onSlopeEnabled={onSlopeEnabled}
            onOpenFolders={() => {
              onToggle(false);
              setFoldersOpen(true);
            }}
            onClose={() => onToggle(false)}
          />
        </MapSheet>
      )}
      <OverlaysDialogs
        foldersOpen={foldersOpen}
        onFoldersDismiss={() => setFoldersOpen(false)}
        snackbar={snackbar}
      />
    </>
  );
}

const styles = StyleSheet.create({
  body: { paddingBottom: 4 },
  backRow: { borderRadius: 12, marginHorizontal: 4 },
  backInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 48,
    paddingHorizontal: 8,
  },
  backTitle: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  weatherRow: { borderRadius: 12, marginHorizontal: 4 },
  weatherRowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 12,
  },
  disc: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weatherText: { flex: 1 },
  weatherLabel: { fontSize: 15, lineHeight: 20 },
  weatherHint: { fontSize: 12, lineHeight: 16 },
  bold: { fontWeight: '700' },
});
