import { sheetBodyMaxHeight } from '@core/map/sheetFit';
import { useMapAreaBottom, useWindowEdge } from '../mapAreaBottom';
import { WEATHER_LAYERS, weatherLayerById, type WeatherLayerId } from '@core/geo/weatherLayers';
import { MARINE_LAYER_IDS } from '@core/geo/marineLayers';
import { MARINE_ENABLED, PARKED_LABEL, WEATHER_ENABLED } from '@core/features/flags';
import { WHITE_KEY_LEVELS, nearestWhiteKeyLevel, whiteKeyLabel } from '@core/geo/pdfWhiteKey';
import { radarAvailableAt } from '@core/weather/modelCoverage';
import {
  PEAK_DENSITIES,
  PEAK_DENSITY_LABEL,
  SHADING_LABEL,
  SHADING_LEVELS,
  type ShadingLevel,
} from '@core/map/terrainOptions';
import { TILT_RELIEF_LABEL, TILT_RELIEFS } from '@core/map/tiltRelief';
import { nativeTerrainAvailable } from '@lib/nativeTerrain';
import { IMAGERY_LOOK_LABEL, IMAGERY_LOOKS } from '@core/map/satelliteImagery';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { cragTilesUrl } from '@data/climbing';
import { GeodeticFilterPanel } from './GeodeticFilterPanel';
import { ExtensionsPanel } from './ExtensionsPanel';
import {
  OVERLAY_TABS,
  OVERLAY_TAB_LABEL,
  OVERLAY_TAB_SHORT,
  tabForRow,
  type OverlayRow,
  type OverlayTab,
} from '@core/map/overlayTabs';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Icon, Text, TouchableRipple } from 'react-native-paper';
import {
  CONTOUR_INTERVALS,
  contourIntervalLabel,
  DisclaimerSnackbar,
  useSlopeDisclaimer,
} from './terrainOverlayControls';
import { FolderPickerDialog } from './FolderPickerDialog';
import { MapButton } from './MapButton';
import {
  ControlRow,
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
import { StepSlider } from './StepSlider';

/**
 * THE overlays menu (#484 redesign): everything drawn on top of the base map,
 * as ONE themed, scrolling sheet in the Map type panel's visual language —
 * section titles, icon + label + one-line hint rows, Switches instead of
 * checkboxes, segmented pickers where a row has levels. It replaces the
 * D-6 drill-down (top-level groups → Topology sub-menu on a fixed dark slab):
 *
 * Four tabs (`@core/map/overlayTabs`; the last one is remembered):
 * - Map — Content (folder picker), PDF maps, Parks, Labels on satellite,
 *   Imagery.
 * - Terrain — Shading, 3D relief, Contours (+ density), Slope (+ range),
 *   Peaks, and last See-through white (the PDF maps' white paper, a 5-stop
 *   slider: Off, 25 / 50 / 75 / 100 %; needs PDF maps).
 * - Sports — Personal heatmap; Live layers: Weather (drills into its list)
 *   and Marine, both parked this release (greyed "Coming soon", never
 *   removed: a feature that silently disappears reads as a bug). Climbing
 *   crags will join here.
 * - Extensions — the installed extensions' switches and legends (geodetic
 *   filter funnel), "Get more extensions"; an empty state with none.
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
 * The rows scroll inside a capped height. The slope RangeSlider and the
 * see-through StepSlider ('See-through white', one adjustable element) claim
 * their touches at touch-down and refuse termination, so a drag beats the
 * ScrollView; the level pickers are taps.
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
/** See-through white's slider stops: Off, 25 %, 50 %, 75 %, 100 %. */
const WHITE_KEY_STOPS = WHITE_KEY_LEVELS.map(whiteKeyLabel);
const IMAGERY = IMAGERY_LOOKS.map((l) => ({ value: l, label: IMAGERY_LOOK_LABEL[l] }));
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
  tab,
  onSlopeEnabled,
  onOpenFolders,
  onOpenWeather,
}: {
  tab: Exclude<OverlayTab, 'extensions'>;
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
  const intervalM = useSettingsStore((s) => s.terrainContourIntervalM);
  const slopeMinDeg = useSettingsStore((s) => s.terrainSlopeMinDeg);
  const slopeMaxDeg = useSettingsStore((s) => s.terrainSlopeMaxDeg);
  const showHeatmap = useSettingsStore((s) => s.showHeatmap);
  const showPdfMaps = useSettingsStore((s) => s.showPdfOverlay);
  const pdfWhiteKey = useSettingsStore((s) => s.pdfWhiteKey);
  const satelliteLabels = useSettingsStore((s) => s.satelliteLabels);
  const satelliteImagery = useSettingsStore((s) => s.satelliteImagery);
  const showHillshade = useSettingsStore((s) => s.showHillshade);
  const hillshadeStrength = useSettingsStore((s) => s.hillshadeStrength);
  const peakDensity = useSettingsStore((s) => s.peakDensity);
  const showParks = useSettingsStore((s) => s.showParks);
  const climbingAvailable = cragTilesUrl() !== null;
  const climbingInstalled = useSettingsStore((s) => s.climbingInstalledAt > 0);
  const showClimbing = useSettingsStore((s) => s.showClimbing);
  const climbingShowAll = useSettingsStore((s) => s.climbingShowAll);
  const tiltRelief = useSettingsStore((s) => s.tiltRelief);
  const nativeTerrain3d = nativeTerrainAvailable();
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
  const parksAvailable = !onSatellite || satelliteLabels;

  // Marine chart mode is all-or-nothing (D-6 amendment): on = every catalog
  // layer, off = none. While parked the persisted array is left ALONE but
  // reads as off, so the row never shows a mode the map is not drawing.
  const marineOn = MARINE_ENABLED && marineLayers.length > 0;
  const weatherName = weatherLayer !== null ? weatherLayerById(weatherLayer).label : null;

  // One tab at a time (@core/map/overlayTabs): Map · Terrain · Sports. The
  // Extensions tab is the ExtensionsPanel, rendered by the sheet.
  if (tab === 'terrain') {
    return (
      <>
        <LevelsRow
          icon="image-filter-hdr"
          label="Shading"
          levels={SHADING}
          selected={shading}
          onSelect={setShading}
        />
        {/* #480: how much the relief deepens when the map is tilted (two
          fingers). With the native 3D terrain the mountains really rise —
          on every base map, so it no longer needs Shading; without it
          (older binaries) it deepens the hillshade and rests with Shading None. */}
        <LevelsRow
          icon="rotate-3d-variant"
          label="3D relief"
          hint={
            nativeTerrain3d
              ? 'Real 3D when you tilt the map'
              : showHillshade
                ? 'When you tilt the map'
                : 'Needs shading'
          }
          levels={TILT}
          selected={tiltRelief}
          onSelect={(r) => set('tiltRelief', r)}
          disabled={!showHillshade && !nativeTerrain3d}
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
        {/* How see-through the PDF maps' white paper is, so the base map shows
          through open land and margins. The default for every PDF map; a
          map can override it from its Library ⋮ menu. Last in Terrain (owner,
          2026-10-05: less important than the rest); still needs PDF maps. */}
        <ControlRow
          icon="circle-opacity"
          label="See-through white"
          hint={showPdfMaps ? 'See the map below white areas' : 'Needs PDF maps'}
          disabled={!showPdfMaps}
        >
          <StepSlider
            labels={WHITE_KEY_STOPS}
            value={pdfWhiteKey}
            onChange={(stop) => set('pdfWhiteKey', nearestWhiteKeyLevel(stop))}
            width={sheetW - BELOW_INSET - RANGE_VALUE_W}
            disabled={!showPdfMaps}
            accessibilityLabel="See-through white"
            accentColor={accent}
            trackColor={tokens.surfaceVariant}
            tickColor={tokens.inkMuted}
          />
        </ControlRow>
      </>
    );
  }
  if (tab === 'sports') {
    return (
      <>
        <SectionTitle>Your activity</SectionTitle>
        <SwitchRow
          icon="fire"
          label="Personal heatmap"
          hint="Where you have been, by visits"
          value={showHeatmap}
          onToggle={() => set('showHeatmap', !showHeatmap)}
        />
        {/* Climbing crags (Settings → Extensions): installed by "Get" or by
          the first crag download (then the saved crags only). */}
        {climbingAvailable && (
          <SwitchRow
            icon="terrain"
            label="Climbing crags"
            hint={
              !climbingInstalled
                ? 'Download a crag from Explore › Climbing'
                : climbingShowAll
                  ? 'Every crag · saved ones filled'
                  : 'Your saved crags'
            }
            value={climbingInstalled && showClimbing}
            disabled={!climbingInstalled}
            onToggle={() => set('showClimbing', !showClimbing)}
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
          hint={
            !MARINE_ENABLED ? PARKED_LABEL : offlineOnly ? 'Needs connection' : 'Nautical chart'
          }
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
      {/* National parks, reserves and protected areas: boundary and name on
          the vector map. Over imagery they ride "Labels on satellite" (the
          same vector pass), so the row rests while that is off. */}
      <SwitchRow
        icon="pine-tree"
        label="Parks & protected areas"
        hint={parksAvailable ? 'Boundaries and names' : 'Needs labels on satellite'}
        value={showParks}
        disabled={!parksAvailable}
        onToggle={() => set('showParks', !showParks)}
      />
      <SwitchRow
        icon="label-outline"
        label="Labels on satellite"
        hint={onSatellite ? 'Trails and names over imagery' : 'For the Satellite map type'}
        value={satelliteLabels}
        disabled={!onSatellite}
        onToggle={() => set('satelliteLabels', !satelliteLabels)}
      />
      {/* #495: Esri's imagery reads dark under forest and in shadow; a
          client-side lift (Brighter by default) or the tiles as served. */}
      <LevelsRow
        icon="brightness-6"
        label="Imagery"
        hint={onSatellite ? 'Satellite brightness' : 'For the Satellite map type'}
        levels={IMAGERY}
        selected={satelliteImagery}
        onSelect={(l) => set('satelliteImagery', l)}
        disabled={!onSatellite}
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
 * The sheet's tabs (Map · Terrain · Sports · Ext.): a segmented strip under
 * the title, in the sheet's accent. Each tab is a button with its full name
 * as label and `selected` state.
 */
function OverlayTabBar({ tab, onSelect }: { tab: OverlayTab; onSelect: (t: OverlayTab) => void }) {
  const tokens = useSchemeTokens();
  const { accent, onAccent } = useSheetAccent();
  return (
    <View
      style={[styles.tabBar, { backgroundColor: tokens.surfaceVariant }]}
      accessibilityRole="tablist"
    >
      {OVERLAY_TABS.map((t) => {
        const selected = t === tab;
        return (
          <Pressable
            key={t}
            onPress={() => onSelect(t)}
            accessibilityRole="tab"
            accessibilityLabel={`${OVERLAY_TAB_LABEL[t]} tab`}
            accessibilityState={{ selected }}
            style={[styles.tab, selected && { backgroundColor: accent }]}
          >
            <Text
              numberOfLines={1}
              style={[styles.tabLabel, { color: selected ? onAccent : tokens.inkVariant }]}
            >
              {OVERLAY_TAB_SHORT[t]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The sheet's content: title + ✕, then the scrolling rows (or the weather
 * list). Mounted only while the menu is open, so it always opens at the top.
 */
export function OverlaysPanel({
  onSlopeEnabled,
  onOpenFolders,
  onClose,
  openOn,
}: {
  onSlopeEnabled: () => void;
  onOpenFolders: () => void;
  onClose: () => void;
  /**
   * Open on this row's tab (`@core/map/overlayTabs`, e.g. 'geodeticFilter')
   * instead of the remembered one. The geodetic filter also opens itself.
   */
  openOn?: OverlayRow;
}) {
  const [weatherOpen, setWeatherOpen] = useState(false);
  // The remembered tab (persisted), unless a caller asked for a row.
  const savedTab = useSettingsStore((s) => s.overlaysTab);
  const setSetting = useSettingsStore((s) => s.set);
  const [tab, setTabState] = useState<OverlayTab>(() =>
    openOn !== undefined ? tabForRow(openOn) : savedTab,
  );
  const setTab = (t: OverlayTab) => {
    setTabState(t);
    setSetting('overlaysTab', t);
  };
  // The Extensions tab's drill-in: the geodetic filter.
  const [filterOpen, setFilterOpen] = useState(openOn === 'geodeticFilter');
  const { height: windowH } = useWindowDimensions();
  // Stay above the tab bar: capped at 60 % of the window alone, the sheet ran
  // behind it on a phone and "Live layers" could never be scrolled to.
  const areaBottom = useMapAreaBottom();
  const { ref: bodyRef, onLayout: onBodyLayout, value: bodyTop } = useWindowEdge('top');
  return (
    <>
      <SheetHeader title="Overlays" closeLabel="Close overlays" onClose={onClose} />
      {!weatherOpen && !filterOpen && <OverlayTabBar tab={tab} onSelect={setTab} />}
      <ScrollView
        ref={bodyRef as never}
        onLayout={onBodyLayout}
        style={{
          maxHeight: sheetBodyMaxHeight({
            windowHeight: windowH,
            maxShare: BODY_MAX_SHARE,
            areaBottom,
            bodyTop,
          }),
        }}
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator
        keyboardShouldPersistTaps="handled"
      >
        {weatherOpen ? (
          <WeatherList onBack={() => setWeatherOpen(false)} />
        ) : tab === 'extensions' && filterOpen ? (
          <GeodeticFilterPanel onBack={() => setFilterOpen(false)} />
        ) : tab === 'extensions' ? (
          <ExtensionsPanel onOpenGeodeticFilter={() => setFilterOpen(true)} onClose={onClose} />
        ) : (
          <OverlayRows
            tab={tab}
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
  open,
  onToggle,
  hideTrigger = false,
}: {
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
  tabBar: {
    flexDirection: 'row',
    borderRadius: 12,
    padding: 3,
    marginHorizontal: 16,
    marginBottom: 6,
    gap: 2,
  },
  tab: {
    flex: 1,
    minHeight: 36,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabLabel: { fontSize: 14, fontWeight: '600' },
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
