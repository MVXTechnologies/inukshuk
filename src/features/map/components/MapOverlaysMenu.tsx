import { WEATHER_LAYERS, weatherLayerById, type WeatherLayerId } from '@core/geo/weatherLayers';
import { MARINE_LAYER_IDS } from '@core/geo/marineLayers';
import { radarAvailableAt } from '@core/weather/modelCoverage';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { useState, type ReactNode } from 'react';
import { PixelRatio, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { FAB, Icon, Text, TouchableRipple } from 'react-native-paper';
import {
  CONTOUR_INTERVALS,
  contourIntervalLabel,
  DisclaimerSnackbar,
  useSlopeDisclaimer,
} from '../terrain3d/overlayControls';
import { weatherChrome as wc } from '../weather/weatherChrome';
import { DetentSlider } from './DetentSlider';
import { FolderPickerDialog } from './FolderPickerDialog';
import { RangeSlider } from './RangeSlider';
import { TrailNetworksDialog } from './TrailNetworksDialog';

/**
 * THE overlays menu (D-6 drill-down rework): everything drawn on top of the
 * base map lives here, organised as an in-place drill-down on one dark
 * translucent slab (the weather chrome, see weatherChrome.ts) instead of the
 * old flat paper Menu + pop-up dialogs. The top level shows GROUPS —
 * Topology and Weather drill into sub-menus that replace the panel content
 * (back arrow returns); Marine (D-6 amendment) is a single all-or-nothing
 * chart-mode toggle right at the top level. The panel mounts fresh on every
 * open, so it always opens at the top level.
 *
 * Plain themed Views throughout — never a Portal/Dialog (the invisible-
 * overlay soft-lock landmine) and never a Paper Surface (the absolutely-
 * positioned iOS flex collapse) — following WeatherModelSheet's pattern. The
 * folder picker and trail-networks dialogs it launches stay user-invoked
 * paper Dialogs (safe per [[paper-portal-touch-swallow]]).
 *
 * A11y/Maestro contract: the opener keeps the EXACT label 'Map overlays'.
 * Group rows carry the labels the flows key on — 'Topology',
 * 'Weather'/'Weather: <layer>', 'Marine' — and the sub-menus keep the row
 * labels the old dialogs had ('Rain radar', 'Temperature', …, 'None',
 * 'Content: …', 'Slope', 'Contours', 'Marked trails', 'Heatmap'). Sub-menu
 * titles render inside the back button (label 'Back to overlays'), so they
 * never echo group-row matchers. There is no 'Done' — closing is back/
 * outside tap.
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

/** Fixed dark-slab palette for the sliders re-homed onto the panel. */
const SLIDER_PALETTE = {
  accentColor: wc.accent,
  trackColor: 'rgba(255, 255, 255, 0.24)',
  tickColor: wc.inkFaint,
};

type OverlayGroup = 'topology' | 'weather';

/** "Slope, Contours" / "Heatmap on" / "off" — the Topology group subtitle. */
function topologySummary(parts: string[]): string {
  if (parts.length === 0) return 'off';
  if (parts.length === 1) return `${parts[0]} on`;
  return parts.join(', ');
}

/** One top-level group/toggle row: 40 px icon slot, name + state subtitle. */
function GroupRow({
  icon,
  name,
  subtitle,
  accessibilityLabel,
  disabled,
  onPress,
  checked,
}: {
  icon: string;
  name: string;
  subtitle: string;
  accessibilityLabel: string;
  disabled?: boolean;
  onPress: () => void;
  /** undefined → drill-down row ('›'); boolean → toggle row (checkbox). */
  checked?: boolean;
}) {
  return (
    <TouchableRipple
      onPress={onPress}
      disabled={disabled}
      // `accessible` collapses the row into ONE element on iOS, so the label
      // below is authoritative. Without it iOS also exposes the name/subtitle
      // Texts and the row's accessible string carries the state ("off"),
      // which broke every full-match flow matcher (2026-08-10).
      accessible
      accessibilityLabel={accessibilityLabel}
      accessibilityState={checked === undefined ? undefined : { checked }}
      style={styles.groupRow}
      borderless
    >
      <View style={[styles.groupRowInner, disabled === true && styles.dimmed]}>
        <View style={styles.iconSlot}>
          <Icon source={icon} size={24} color={wc.ink} />
        </View>
        <View style={styles.groupText}>
          <Text style={styles.groupName}>{name}</Text>
          <Text style={styles.groupState} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        {checked === undefined ? (
          <Icon source="chevron-right" size={22} color={wc.inkFaint} />
        ) : (
          <Icon
            source={checked ? 'checkbox-marked' : 'checkbox-blank-outline'}
            size={22}
            color={checked ? wc.accent : wc.inkMuted}
          />
        )}
      </View>
    </TouchableRipple>
  );
}

/** Sub-menu title bar: '‹' + title, one tap target back to the top level. */
function SubmenuHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <TouchableRipple
      onPress={onBack}
      accessibilityLabel="Back to overlays"
      style={styles.backRow}
      borderless
    >
      <View style={styles.backInner}>
        <Icon source="chevron-left" size={24} color={wc.ink} />
        <Text style={styles.backTitle}>{title}</Text>
      </View>
    </TouchableRipple>
  );
}

/** Compact dark-chrome list row (icon + title, optional trailing chevron). */
function ItemRow({
  icon,
  iconColor,
  title,
  accessibilityLabel,
  onPress,
  chevron = false,
}: {
  icon: string;
  iconColor?: string;
  title: string;
  accessibilityLabel?: string;
  onPress: () => void;
  chevron?: boolean;
}) {
  return (
    <TouchableRipple
      onPress={onPress}
      accessibilityLabel={accessibilityLabel ?? title}
      style={styles.itemRow}
      borderless
    >
      <View style={styles.itemRowInner}>
        <View style={styles.iconSlot}>
          <Icon source={icon} size={22} color={iconColor ?? wc.ink} />
        </View>
        <Text style={styles.itemLabel}>{title}</Text>
        {chevron && <Icon source="chevron-right" size={20} color={wc.inkFaint} />}
      </View>
    </TouchableRipple>
  );
}

/**
 * Topology sub-menu: the terrain-analysis and content rows re-homed from the
 * old flat menu — Content picker, Slope (+ range), Contours (+ interval),
 * Elevation tint (3D only), Marked trails, Heatmap. Sliders render always
 * (dimmed while off) and sit inline on the right, as before.
 */
function TopologySubmenu({
  showHypso,
  onSlopeEnabled,
  onOpenFolders,
  onOpenTrailNetworks,
  onBack,
}: {
  showHypso: boolean;
  onSlopeEnabled: () => void;
  onOpenFolders: () => void;
  onOpenTrailNetworks: () => void;
  onBack: () => void;
}) {
  const mapVisibilityMode = useLibraryStore((s) => s.mapVisibilityMode);
  const visibleFolderIds = useLibraryStore((s) => s.visibleFolderIds);
  const typeMode = mapVisibilityMode === 'type';
  const networks = useSettingsStore((s) => s.markedTrailsNetworks);
  const slope = useSettingsStore((s) => s.terrainSlope);
  const contours = useSettingsStore((s) => s.terrainContours);
  const hypso = useSettingsStore((s) => s.terrainHypso);
  const intervalM = useSettingsStore((s) => s.terrainContourIntervalM);
  const slopeMinDeg = useSettingsStore((s) => s.terrainSlopeMinDeg);
  const slopeMaxDeg = useSettingsStore((s) => s.terrainSlopeMaxDeg);
  const showHeatmap = useSettingsStore((s) => s.showHeatmap);
  const set = useSettingsStore((s) => s.set);

  const contentTitle = typeMode
    ? 'Content: everything'
    : `Content: ${visibleFolderIds.length} folder${visibleFolderIds.length === 1 ? '' : 's'}`;

  const checkRow = (label: string, on: boolean, onToggle: () => void, control?: ReactNode) => (
    <View style={styles.layerRow}>
      <TouchableRipple
        onPress={onToggle}
        accessibilityLabel={label}
        accessibilityState={{ checked: on }}
        style={styles.layerToggle}
        borderless
      >
        <View style={styles.layerLabelBox}>
          <View style={styles.iconSlot}>
            <Icon
              source={on ? 'checkbox-marked' : 'checkbox-blank-outline'}
              size={22}
              color={on ? wc.accent : wc.inkMuted}
            />
          </View>
          <Text style={styles.itemLabel}>{label}</Text>
        </View>
      </TouchableRipple>
      {control !== undefined && <View style={styles.rightCol}>{control}</View>}
    </View>
  );

  return (
    <View>
      {/* No scroll container here — b39ebc9 wrapped these rows in one and
          f3180c8 reverted it. Two mechanisms make a ScrollView wrong for
          THIS list specifically:
          - Gesture: the rows host RangeSlider/DetentSlider. A vertical
            ScrollView competes with the thumbs' pan responder, so drags get
            claimed by the scroll instead of the slider.
          - Reach: rows past the capped height are off-screen, and Android's
            removeClippedSubviews may unmount them outright. (They are NOT
            "hidden from the a11y tree" — the tree still describes them; they
            simply aren't on screen, which is what Maestro's tapOn needs.)
          Flows that depend on every Topology row staying reachable and
          draggable: map-overlays.yaml (Slope, Contours, the interval detents
          and the slope-range label), folders.yaml and heatmap.yaml (the
          Content row). Verify against those three before adding a cap here.
          Topology fits its sheet as-is — the Weather list was the one that
          grew, so the cap lives there instead. */}
      <SubmenuHeader title="Topology" onBack={onBack} />
      <ItemRow
        icon={typeMode ? 'folder-multiple-outline' : 'folder-multiple'}
        title={contentTitle}
        onPress={onOpenFolders}
        chevron
      />
      {checkRow(
        'Slope',
        slope,
        () => {
          const next = !slope;
          set('terrainSlope', next);
          if (next) onSlopeEnabled();
        },
        <RangeSlider
          min={0}
          max={90}
          width={100}
          lo={slopeMinDeg}
          hi={slopeMaxDeg}
          disabled={!slope}
          accessibilityLabel={`Slope range ${slopeMinDeg} to ${slopeMaxDeg} degrees`}
          onChange={(newLo, newHi) => {
            set('terrainSlopeMinDeg', newLo);
            set('terrainSlopeMaxDeg', newHi);
          }}
          {...SLIDER_PALETTE}
        />,
      )}
      {checkRow(
        'Contours',
        contours,
        () => set('terrainContours', !contours),
        <View style={!contours && styles.dimmed}>
          <DetentSlider
            detents={CONTOUR_INTERVALS.map((m) => ({ value: m, label: contourIntervalLabel(m) }))}
            selected={intervalM}
            onSelect={(m) => set('terrainContourIntervalM', m)}
            disabled={!contours}
            width={100}
            {...SLIDER_PALETTE}
          />
        </View>,
      )}
      {showHypso && checkRow('Elevation tint', hypso, () => set('terrainHypso', !hypso))}
      <ItemRow
        icon={networks.length > 0 ? 'checkbox-marked' : 'checkbox-blank-outline'}
        iconColor={networks.length > 0 ? wc.accent : wc.inkMuted}
        title={networks.length > 0 ? `Marked trails (${networks.length})` : 'Marked trails'}
        onPress={onOpenTrailNetworks}
        chevron
      />
      {checkRow('Heatmap', showHeatmap, () => set('showHeatmap', !showHeatmap))}
    </View>
  );
}

/**
 * Weather sub-menu: the old WeatherLayersDialog's icon-disc rows verbatim —
 * layer icon on a subtle dark disc, accent ring + bolder label on the
 * selection, the ECCC hint line, and the honest "Canada only" hint on radar
 * rows while the map centre sits outside the North American composite.
 */
function WeatherSubmenu({ onBack }: { onBack: () => void }) {
  const weatherLayer = useSettingsStore((s) => s.weatherLayer);
  const set = useSettingsStore((s) => s.set);
  // Boolean selector, so the panel only re-renders when the answer flips at
  // the coverage edge.
  const radarOutside = useMapStore((s) => !radarAvailableAt(s.mapCenter));

  // Scroll cap, derived rather than a magic number. A row is its vertical
  // padding plus its tallest child — normally the selection ring, but the
  // label overtakes it once the user's text size scales up, which is exactly
  // the case a fixed cap used to clip INSIDE the row instead of scrolling.
  const { height: windowH } = useWindowDimensions();
  const rowH =
    2 * WEATHER_ROW_PAD_V +
    Math.max(WEATHER_RING_D, WEATHER_LABEL_LINE * PixelRatio.getFontScale());
  // The half row is deliberate: a partially-clipped row is the affordance
  // that says "there is more below" (with the scroll indicator as backup).
  // Clamped against the window so landscape and small phones can't hand the
  // sheet a cap taller than the screen it has to sit in.
  const listMaxHeight = Math.min(rowH * WEATHER_VISIBLE_ROWS, windowH * 0.45);

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
          <View style={[styles.discRing, selected && styles.discRingSelected]}>
            <View style={styles.disc}>
              <Icon
                source={id === null ? 'eye-off-outline' : WEATHER_LAYER_ICONS[id]}
                size={WEATHER_ICON}
                color={id === null ? wc.inkMuted : wc.ink}
              />
            </View>
          </View>
          <View style={styles.weatherRowText}>
            <Text style={[styles.weatherRowLabel, selected && styles.weatherRowLabelSelected]}>
              {label}
            </Text>
            {hint !== undefined && <Text style={styles.weatherRowHint}>{hint}</Text>}
          </View>
          {selected && <Icon source="check" size={18} color={wc.accent} />}
        </View>
      </TouchableRipple>
    );
  };

  return (
    <View>
      <SubmenuHeader title="Weather" onBack={onBack} />
      {/* Owner call (2026-08-10): a sub-menu must occupy the SAME footprint as
          the menu it replaces — no growing panel that swallows the map, so
          the list scrolls inside a capped height instead of stretching.

          The three-line ECCC explainer that used to sit here was DROPPED, not
          moved — it cost more height than every row it explained. Both facts
          it carried still reach the user, and earlier than before:
          - Attribution: `mapDataCredits.ts` already folds ECCC_ATTRIBUTION
            into Settings → System info → Maps & data (it was always there;
            this sub-menu was a duplicate, not the source).
          - "Needs a connection / hidden while Locally downloaded only is on":
            carried by the Weather GROUP row in OverlaysDrilldown, which goes
            disabled with a "Needs connection" subtitle and a matching a11y
            label while offlineOnly is set. That states the caveat one level
            UP, where it is actionable — under offlineOnly you can no longer
            open this sub-menu at all, so a hint inside it was unreachable
            exactly when it applied. */}
      <ScrollView style={{ maxHeight: listMaxHeight }} showsVerticalScrollIndicator>
        {row(null, 'None')}
        {WEATHER_LAYERS.map((l) =>
          row(l.id, l.label, l.timeline === 'past' && radarOutside ? 'Canada only' : undefined),
        )}
      </ScrollView>
    </View>
  );
}

/**
 * The drill-down content, shared by the classic/minimal rail's sheet and the
 * edge rail's expanding panel. Mounted only while the menu is open, so the
 * level always resets to the top.
 */
export function OverlaysDrilldown({
  showHypso,
  onSlopeEnabled,
  onOpenFolders,
  onOpenTrailNetworks,
}: {
  /** Show the 3D-only Elevation tint row (when the 3D view is active). */
  showHypso: boolean;
  onSlopeEnabled: () => void;
  onOpenFolders: () => void;
  onOpenTrailNetworks: () => void;
}) {
  const [group, setGroup] = useState<OverlayGroup | null>(null);
  const offlineOnly = useSettingsStore((s) => s.offlineOnly);
  const networks = useSettingsStore((s) => s.markedTrailsNetworks);
  const weatherLayer = useSettingsStore((s) => s.weatherLayer);
  const marineLayers = useSettingsStore((s) => s.marineLayers);
  const showHeatmap = useSettingsStore((s) => s.showHeatmap);
  const slope = useSettingsStore((s) => s.terrainSlope);
  const contours = useSettingsStore((s) => s.terrainContours);
  const hypso = useSettingsStore((s) => s.terrainHypso);
  const set = useSettingsStore((s) => s.set);

  if (group === 'topology')
    return (
      <TopologySubmenu
        showHypso={showHypso}
        onSlopeEnabled={onSlopeEnabled}
        onOpenFolders={onOpenFolders}
        onOpenTrailNetworks={onOpenTrailNetworks}
        onBack={() => setGroup(null)}
      />
    );
  if (group === 'weather') return <WeatherSubmenu onBack={() => setGroup(null)} />;

  const topoParts: string[] = [];
  if (slope) topoParts.push('Slope');
  if (contours) topoParts.push('Contours');
  if (showHypso && hypso) topoParts.push('Elevation tint');
  if (networks.length > 0) topoParts.push('Marked trails');
  if (showHeatmap) topoParts.push('Heatmap');

  // Marine chart mode is all-or-nothing (D-6 amendment): depth bands and
  // seamarks drape together as one iBoating-style mode. The store keeps the
  // marineLayers array shape — on = every catalog layer, off = none.
  const marineOn = marineLayers.length > 0;

  return (
    <View>
      <Text style={styles.caption}>OVERLAYS</Text>
      <GroupRow
        icon="terrain"
        name="Topology"
        subtitle={topologySummary(topoParts)}
        accessibilityLabel="Topology"
        onPress={() => setGroup('topology')}
      />
      {/* Weather and marine are network-only: while "Locally downloaded
          only" is on (Settings → Data settings) the layers are dropped from
          the style, so the rows are disabled with a hint instead of
          pretending a pick would show anything. */}
      <GroupRow
        icon="weather-partly-cloudy"
        name="Weather"
        subtitle={
          offlineOnly
            ? 'Needs connection'
            : weatherLayer !== null
              ? weatherLayerById(weatherLayer).label
              : 'off'
        }
        accessibilityLabel={
          offlineOnly
            ? 'Weather (needs connection)'
            : weatherLayer !== null
              ? `Weather: ${weatherLayerById(weatherLayer).label}`
              : 'Weather'
        }
        disabled={offlineOnly}
        onPress={() => setGroup('weather')}
      />
      <GroupRow
        icon="anchor"
        name="Marine"
        subtitle={offlineOnly ? 'Needs connection' : marineOn ? 'on' : 'off'}
        accessibilityLabel={offlineOnly ? 'Marine (needs connection)' : 'Marine'}
        disabled={offlineOnly}
        checked={marineOn}
        onPress={() => set('marineLayers', marineOn ? [] : [...MARINE_LAYER_IDS])}
      />
    </View>
  );
}

/** The dialogs the drill-down launches, hosted once by whichever rail shows. */
export function OverlaysDialogs({
  foldersOpen,
  onFoldersDismiss,
  networksOpen,
  onNetworksDismiss,
  snackbar,
}: {
  foldersOpen: boolean;
  onFoldersDismiss: () => void;
  networksOpen: boolean;
  onNetworksDismiss: () => void;
  snackbar: ReturnType<typeof useSlopeDisclaimer>['snackbar'];
}) {
  return (
    <>
      <FolderPickerDialog visible={foldersOpen} onDismiss={onFoldersDismiss} />
      <TrailNetworksDialog visible={networksOpen} onDismiss={onNetworksDismiss} />
      <DisclaimerSnackbar snackbar={snackbar} />
    </>
  );
}

/**
 * Classic/minimal styles: the overlays FAB + the drill-down sheet unfolding
 * beneath it in the rail's own column (the MapActionsMenu idiom). `open` is
 * owned by the rail so it can drop the map-covering backdrop that closes the
 * sheet on an outside tap.
 */
export function MapOverlaysMenu({
  showHypso = false,
  open,
  onToggle,
}: {
  showHypso?: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [networksOpen, setNetworksOpen] = useState(false);
  const { snackbar, onSlopeEnabled } = useSlopeDisclaimer();

  return (
    <>
      <FAB
        icon="gradient-vertical"
        size="small"
        variant="surface"
        onPress={() => onToggle(!open)}
        style={styles.controlFab}
        accessibilityLabel="Map overlays"
      />
      {open && (
        <View style={styles.sheet}>
          <OverlaysDrilldown
            showHypso={showHypso}
            onSlopeEnabled={onSlopeEnabled}
            onOpenFolders={() => {
              onToggle(false);
              setFoldersOpen(true);
            }}
            onOpenTrailNetworks={() => {
              onToggle(false);
              setNetworksOpen(true);
            }}
          />
        </View>
      )}
      <OverlaysDialogs
        foldersOpen={foldersOpen}
        onFoldersDismiss={() => setFoldersOpen(false)}
        networksOpen={networksOpen}
        onNetworksDismiss={() => setNetworksOpen(false)}
        snackbar={snackbar}
      />
    </>
  );
}

/** 40 px icon disc — same slot the old gradient thumbnail occupied. */
const DISC_D = 40;
/** Weather rows use a smaller disc so the sub-menu keeps the top level's
 * footprint (owner call 2026-08-10). */
const WEATHER_DISC = 30;
/** Glyph inside the weather disc, sized to leave a ring of padding around it. */
const WEATHER_ICON = Math.round(WEATHER_DISC * 0.57);
/** Selection ring around the disc — the tallest fixed child of a weather row. */
const WEATHER_RING_D = WEATHER_DISC + 6;
/**
 * Row padding. 6 keeps the row at WEATHER_RING_D + 12 = 48 px, which clears
 * both the iOS HIG 44 pt and the Material 48 dp touch minimums; 3 (briefly
 * shipped on this branch) put it at 42 and missed both.
 */
const WEATHER_ROW_PAD_V = 6;
/** Label line box at fontScale 1 — the row grows past the ring beyond that. */
const WEATHER_LABEL_LINE = 20;
/**
 * Rows visible before the list scrolls. The catalog is 6 rows today (None +
 * WEATHER_LAYERS) and `weatherLayers.ts` says it deliberately tolerates more,
 * so this has to keep working as entries are appended: at 5.5 every row the
 * e2e flows reach — None, Rain/Snow radar, Temperature, Wind — stays fully on
 * screen, and growth spills into the scroll region below them.
 */
const WEATHER_VISIBLE_ROWS = 5.5;

const styles = StyleSheet.create({
  controlFab: { borderRadius: 24 },
  sheet: {
    minWidth: 316,
    maxWidth: 344,
    backgroundColor: wc.panelSolid,
    borderRadius: 18,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  caption: {
    fontSize: 10,
    lineHeight: 12,
    letterSpacing: 1.2,
    color: wc.inkFaint,
    marginLeft: 10,
    marginTop: 4,
    marginBottom: 4,
  },
  // --- top-level group rows ---
  groupRow: { borderRadius: 12 },
  groupRowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 11,
    paddingHorizontal: 8,
  },
  iconSlot: { width: DISC_D, alignItems: 'center' },
  groupText: { flex: 1 },
  groupName: { fontSize: 15, lineHeight: 20, color: wc.ink },
  groupState: { fontSize: 12, lineHeight: 16, color: wc.inkMuted },
  dimmed: { opacity: 0.4 },
  // --- sub-menu chrome ---
  backRow: { borderRadius: 12 },
  backInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  backTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: wc.ink },
  itemRow: { borderRadius: 12 },
  itemRowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  itemLabel: { flex: 1, fontSize: 15, lineHeight: 20, color: wc.ink },
  // --- topology check rows with inline selectors ---
  layerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 10,
  },
  // flex:1 is load-bearing — itemLabel inside is flex:1, so without it the
  // touchable shrinks to its icon and the label renders at zero width
  // (Slope/Contours/Heatmap looked label-less on device).
  layerToggle: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingLeft: 8,
    paddingRight: 6,
  },
  layerLabelBox: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rightCol: { width: 170, alignItems: 'flex-end' },
  // --- weather icon-disc rows (ported from the retired WeatherLayersDialog) ---
  weatherRow: { borderRadius: 12, paddingVertical: WEATHER_ROW_PAD_V, paddingHorizontal: 6 },
  weatherRowInner: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  // Constant-size ring wrapper so selection never shifts the layout.
  discRing: {
    width: WEATHER_RING_D,
    height: WEATHER_RING_D,
    borderRadius: WEATHER_RING_D / 2,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  discRingSelected: { borderColor: wc.accent },
  disc: {
    width: WEATHER_DISC,
    height: WEATHER_DISC,
    borderRadius: WEATHER_DISC / 2,
    backgroundColor: '#353B43',
    alignItems: 'center',
    justifyContent: 'center',
  },
  weatherRowText: { flex: 1 },
  weatherRowLabel: { fontSize: 15, color: wc.ink },
  weatherRowLabelSelected: { fontWeight: '700' },
  weatherRowHint: { fontSize: 11, color: wc.inkFaint },
});
