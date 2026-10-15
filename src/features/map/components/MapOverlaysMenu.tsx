import { sheetBodyMaxHeight } from '@core/map/sheetFit';
import { useMapAreaBottom, useWindowEdge } from '../mapAreaBottom';
import { WEATHER_LAYERS, weatherLayerById, type WeatherLayerId } from '@core/geo/weatherLayers';
import { MARINE_LAYER_IDS } from '@core/geo/marineLayers';
import { MARINE_ENABLED, WEATHER_ENABLED } from '@core/features/flags';
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
import { EXTENSION_PANELS } from '@features/extensions/panelEntries';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { BaseMapCards } from './BaseMapCards';
import { ExtensionsPanel } from './ExtensionsPanel';
import {
  OVERLAY_TABS,
  OVERLAY_TAB_LABEL,
  OVERLAY_TAB_SHORT,
  panelForRow,
  tabForRow,
  tabForSubPanel,
  type OverlayRow,
  type OverlaySubPanel,
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
  LevelsRow,
  MapSheet,
  NavRow,
  SectionTitle,
  Segmented,
  SheetHeader,
  SubPanelButton,
  SubPanelHeader,
  SwitchRow,
  useSheetAccent,
} from './mapSheet';
import { PdfMapsPanel } from './PdfMapsPanel';
import { PointingLinePanel, PointingLineRow } from './PointingLinePanel';
import { openStripEditor } from '../infoStrip/stripRuntime';
import { SatellitePanel } from './SatellitePanel';
import { SlopeRow, SlopeSubPanel } from './SlopePanel';

/**
 * THE overlays menu, titled "Map layers" (#484 redesign; #668–#670): how the
 * map looks, as ONE themed, scrolling sheet — section titles, icon + label +
 * one-line hint rows, Switches, segmented pickers where a row has levels.
 *
 * Four tabs (`@core/map/overlayTabs`; the last one is remembered):
 * - Map — Content (folder picker), PDF maps, Parks & protected areas.
 * - Terrain — the base map (Map / Satellite cards, #669; it was the rail's
 *   "Base map" panel), then Relief: Shading, 3D relief, Contours (+
 *   density), Slope (its page: steepness, altitude, aspect; #723), Peaks.
 * - Sports — Personal heatmap; Live layers: Weather (its list) and Marine,
 *   both parked this release, so not shown at all (no greyed rows, owner
 *   rule, 2.5.1 QA). Climbing crags will join here.
 * - Extensions — the installed extensions' rows, "Get more extensions"; an
 *   empty state with none.
 *
 * Sub-panels (#668, the owner's sub-menu rule: what relates to one item only
 * lives in that item's page, never in a greyed-out row): an item with
 * options of its own carries the round chevron accessory (`SubPanelButton`)
 * and opens them as a page of the sheet, through ONE `openSubPanel(id)`: the
 * tab strip hides, a back row leads back to the tab. Slope, Satellite (labels,
 * imagery brightness), PDF maps (See-through white), Weather (its list) and
 * every extension (`ExtensionPanelModule.Panel`). Nothing in a tab greys out
 * (beyond the network-only rows while offline).
 *
 * A11y/Maestro contract: the opener keeps the EXACT label 'Map overlays';
 * the sheet's ✕ is 'Close overlays' — the open-state sentinel. Rows keep the
 * labels the flows key on: 'Content: …', 'PDF maps', 'Personal heatmap',
 * 'Slope', 'Contours', the level names ('Auto', '50 m', 'Heavy', …), 'Slope
 * minimum/maximum' (in Slope's page), 'Weather'/'Weather: <layer>' and 'Marine' (absent while
 * parked); built-in sub-panels go back with 'Back to
 * overlays', extension ones with 'Back to extensions'. Accessories are named
 * 'Options for <item>' — never starting with the row's own label, so a
 * flow's 'PDF maps.*' still finds the row.
 *
 * The rows scroll inside a capped height. The slope RangeSlider and the
 * see-through StepSlider claim their touches at touch-down and refuse
 * termination, so a drag beats the ScrollView; the level pickers are taps.
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

const SHADING = SHADING_LEVELS.map((l) => ({ value: l, label: SHADING_LABEL[l] }));
const TILT = TILT_RELIEFS.map((r) => ({ value: r, label: TILT_RELIEF_LABEL[r] }));
const PEAKS = PEAK_DENSITIES.map((d) => ({ value: d, label: PEAK_DENSITY_LABEL[d] }));
const CONTOUR_DENSITY = CONTOUR_INTERVALS.map((m) => ({
  value: m,
  label: contourIntervalLabel(m),
}));

/**
 * The overlay rows of the Map, Terrain and Sports tabs (everything but the
 * sheet chrome). `openSubPanel` opens an item's own page.
 */
function OverlayRows({
  tab,
  onSlopeEnabled,
  onOpenFolders,
  openSubPanel,
  onClose,
}: {
  tab: Exclude<OverlayTab, 'extensions'>;
  onSlopeEnabled: () => void;
  onOpenFolders: () => void;
  openSubPanel: (panel: OverlaySubPanel) => void;
  /** Close the sheet (the info strip's editor opens over the map instead). */
  onClose: () => void;
}) {
  const mapVisibilityMode = useLibraryStore((s) => s.mapVisibilityMode);
  const visibleFolderIds = useLibraryStore((s) => s.visibleFolderIds);
  const offlineOnly = useSettingsStore((s) => s.offlineOnly);
  const weatherLayer = useSettingsStore((s) => s.weatherLayer);
  const marineLayers = useSettingsStore((s) => s.marineLayers);
  const contours = useSettingsStore((s) => s.terrainContours);
  const intervalM = useSettingsStore((s) => s.terrainContourIntervalM);
  const showHeatmap = useSettingsStore((s) => s.showHeatmap);
  const showPdfMaps = useSettingsStore((s) => s.showPdfOverlay);
  const showHillshade = useSettingsStore((s) => s.showHillshade);
  const hillshadeStrength = useSettingsStore((s) => s.hillshadeStrength);
  const peakDensity = useSettingsStore((s) => s.peakDensity);
  const showParks = useSettingsStore((s) => s.showParks);
  const tiltRelief = useSettingsStore((s) => s.tiltRelief);
  const stripName = useSettingsStore((s) => s.infoStrip.current.name);
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
        <SectionTitle>Base map</SectionTitle>
        <BaseMapCards onOpenSatellite={() => openSubPanel('satellite')} />
        <SectionTitle>Relief</SectionTitle>
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
        {/* #723: the steepness window moved into Slope's page, with altitude and aspect. */}
        <SlopeRow onOpen={() => openSubPanel('slope')} onSlopeEnabled={onSlopeEnabled} />
        <LevelsRow
          icon="triangle-outline"
          label="Peaks"
          hint="How early summits are named"
          levels={PEAKS}
          selected={peakDensity}
          onSelect={(d) => set('peakDensity', d)}
        />
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
        {/* Climbing crags will join here (owner, 2026-10-05). */}
        {/* Parked layers (see `@core/features/flags`) have NO row: the owner's
          rule is no greyed-out rows (2.5.1 QA). With both parked the section
          is gone. Otherwise these are network-only: under "Locally
          downloaded only" the layers are dropped from the style, so the rows
          are disabled with a hint instead of pretending a pick would show
          anything. */}
        {(WEATHER_ENABLED || MARINE_ENABLED) && <SectionTitle>Live layers</SectionTitle>}
        {WEATHER_ENABLED && (
          <NavRow
            icon="weather-partly-cloudy"
            label="Weather"
            hint={offlineOnly ? 'Needs connection' : (weatherName ?? 'Off')}
            accessibilityLabel={
              offlineOnly
                ? 'Weather (needs connection)'
                : weatherName !== null
                  ? `Weather: ${weatherName}`
                  : 'Weather'
            }
            disabled={offlineOnly}
            onPress={() => openSubPanel('weather')}
          />
        )}
        {MARINE_ENABLED && (
          <SwitchRow
            icon="anchor"
            label="Marine"
            hint={offlineOnly ? 'Needs connection' : 'Nautical chart'}
            accessibilityLabel={offlineOnly ? 'Marine (needs connection)' : 'Marine'}
            value={marineOn}
            disabled={offlineOnly}
            onToggle={() => set('marineLayers', marineOn ? [] : [...MARINE_LAYER_IDS])}
          />
        )}
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
          imported/made sheets whatever the Content picker says. Its page holds
          See-through white (#670). */}
      <SwitchRow
        icon="map-legend"
        label="PDF maps"
        hint={showPdfMaps ? 'Your imported and made maps' : 'Hidden on the map'}
        value={showPdfMaps}
        onToggle={() => set('showPdfOverlay', !showPdfMaps)}
        accessory={
          <SubPanelButton
            onPress={() => openSubPanel('pdfMaps')}
            accessibilityLabel="Options for PDF maps"
          />
        }
      />
      {/* National parks, reserves and protected areas: boundary and name, on
          the Map base and over Satellite alike — its own pass there, with or
          without the labels (#669), so it never greys out. */}
      <SwitchRow
        icon="pine-tree"
        label="Parks & protected areas"
        hint="Boundaries and names"
        value={showParks}
        onToggle={() => set('showParks', !showParks)}
      />
      {/* Map aids (#681): drawn on the map from you; options in its own page. */}
      <SectionTitle>Map aids</SectionTitle>
      {/* The info strip's editor (#673; also a long-press on the strip). */}
      <NavRow
        icon="view-dashboard-edit-outline"
        label="Customize info strip"
        hint={`${stripName} · fields, dock, centre cursor`}
        onPress={() => {
          onClose();
          openStripEditor();
        }}
      />
      <PointingLineRow onOpen={() => openSubPanel('pointingLine')} />
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
      <SubPanelHeader title="Weather" backLabel="Back to overlays" onBack={onBack} />
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
 * The page a sub-panel id opens: a built-in one (Satellite, PDF maps,
 * Weather) or an extension's (`EXTENSION_PANELS[key].Panel`).
 */
function SubPanel({
  panel,
  onBack,
  onClose,
  openSubPanel,
}: {
  panel: OverlaySubPanel;
  onBack: () => void;
  onClose: () => void;
  openSubPanel: (panel: OverlaySubPanel) => void;
}) {
  switch (panel) {
    case 'weather':
      return <WeatherList onBack={onBack} />;
    case 'satellite':
      return <SatellitePanel onBack={onBack} />;
    case 'pdfMaps':
      return <PdfMapsPanel onBack={onBack} />;
    case 'pointingLine':
      return <PointingLinePanel onBack={onBack} />;
    case 'slope':
      return <SlopeSubPanel onBack={onBack} />;
    default: {
      const { Panel } = EXTENSION_PANELS[panel];
      return <Panel onBack={onBack} onClose={onClose} openSubPanel={openSubPanel} />;
    }
  }
}

/**
 * The sheet's content: title + ✕, the tabs, then the scrolling rows — or one
 * item's sub-panel in their place. Mounted only while the menu is open, so
 * it always opens at the top.
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
   * Open on this row (`@core/map/overlayTabs`, e.g. 'geodeticFilter'): on its
   * tab, or in the sub-panel it lives in, instead of the remembered tab.
   */
  openOn?: OverlayRow;
}) {
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
  // The open sub-panel, if any: it takes the body and hides the tab strip.
  const [subPanel, setSubPanel] = useState<OverlaySubPanel | null>(() =>
    openOn !== undefined ? panelForRow(openOn) : null,
  );
  const openSubPanel = (panel: OverlaySubPanel) => {
    const t = tabForSubPanel(panel);
    if (t !== tab) setTab(t);
    setSubPanel(panel);
  };
  const { height: windowH } = useWindowDimensions();
  // Stay above the tab bar: capped at 60 % of the window alone, the sheet ran
  // behind it on a phone and "Live layers" could never be scrolled to.
  const areaBottom = useMapAreaBottom();
  const { ref: bodyRef, onLayout: onBodyLayout, value: bodyTop } = useWindowEdge('top');
  return (
    <>
      <SheetHeader title="Map layers" closeLabel="Close overlays" onClose={onClose} />
      {subPanel === null && <OverlayTabBar tab={tab} onSelect={setTab} />}
      <ScrollView
        // A sub-panel opens at its top (and the tab's list comes back at its own).
        key={subPanel ?? 'tabs'}
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
        {subPanel !== null ? (
          <SubPanel
            panel={subPanel}
            onBack={() => setSubPanel(null)}
            onClose={onClose}
            openSubPanel={openSubPanel}
          />
        ) : tab === 'extensions' ? (
          <ExtensionsPanel onOpenPanel={openSubPanel} onClose={onClose} />
        ) : (
          <OverlayRows
            tab={tab}
            onSlopeEnabled={onSlopeEnabled}
            onOpenFolders={onOpenFolders}
            openSubPanel={openSubPanel}
            onClose={onClose}
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
 * The button is the one way in to how the map looks (#669: the base map
 * moved in), hence the layers icon.
 */
export function MapOverlaysMenu({
  open,
  onToggle,
  openOn,
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  /** Open on this row instead of the remembered tab (the slope legend chip, #723). */
  openOn?: OverlayRow;
}) {
  const [foldersOpen, setFoldersOpen] = useState(false);
  const { snackbar, onSlopeEnabled } = useSlopeDisclaimer();

  return (
    <>
      <MapButton
        icon="layers-outline"
        onPress={() => onToggle(!open)}
        accessibilityLabel="Map overlays"
      />
      {open && (
        <MapSheet>
          <OverlaysPanel
            onSlopeEnabled={onSlopeEnabled}
            onOpenFolders={() => {
              onToggle(false);
              setFoldersOpen(true);
            }}
            onClose={() => onToggle(false)}
            openOn={openOn}
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
