import type { BoundingBox } from '@core/models';
import { useSettingsStore } from '@state/settingsStore';
import { useState } from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  ProgressBar,
  SegmentedButtons,
  Surface,
  Switch,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import { DetentSlider } from '../components/DetentSlider';
import type { DrapeSource } from '../dem';
import type { ComposePhase, MakeMapOptions } from './composeMapPdf';
import { useMakeMapPreview } from './useMakeMapPreview';

/**
 * The map maker's "desk & drawer" editor (design round 2, user-picked):
 * the live preview sits on a dimmed desk in the top half, styled as a real
 * sheet of paper with a drop shadow; a tabbed drawer below holds the
 * controls — Layers (with per-layer opacity), Page (name/basemap/format) and
 * Extras (grid, compass, your data). The preview recomposes from the real
 * tile/DEM sources on every change, captioned with the live print scale.
 * Inline Surface, never Portal/Dialog (paper-portal-touch-swallow).
 */

export type MakeMapProgress = { phase: ComposePhase; frac: number };

interface Props {
  bbox: BoundingBox;
  /** Non-null while composing — switches to the progress view. */
  progress: MakeMapProgress | null;
  onCreate: (options: MakeMapOptions) => void;
  onCancel: () => void;
}

const PHASE_LABEL: Record<ComposePhase, string> = {
  tiles: 'Fetching map tiles…',
  terrain: 'Analyzing terrain…',
  compose: 'Composing the PDF…',
};

/** Overall progress: each phase owns a third of the bar. */
const PHASE_BASE: Record<ComposePhase, number> = { tiles: 0, terrain: 1 / 3, compose: 2 / 3 };

const OPACITY_DETENTS = [0.25, 0.4, 0.55, 0.7, 0.85].map((v) => ({
  value: v,
  label: `${Math.round(v * 100)}%`,
}));

type DrawerTab = 'layers' | 'page' | 'extras';

export function MakeMapSheet({ bbox, progress, onCreate, onCancel }: Props) {
  const theme = useTheme();
  const s = useSettingsStore.getState();
  const [tab, setTab] = useState<DrawerTab>('layers');
  const [name, setName] = useState(`My map ${new Date().toISOString().slice(0, 10)}`);
  const [basemap, setBasemap] = useState<DrapeSource>('map');
  const [format, setFormat] = useState<'a4' | 'letter'>('a4');
  const [contours, setContours] = useState(true);
  const [slope, setSlope] = useState(s.terrainSlope);
  const [slopeOpacity, setSlopeOpacity] = useState(0.55);
  const [markedTrails, setMarkedTrails] = useState(false);
  const [markedTrailsOpacity, setMarkedTrailsOpacity] = useState(0.85);
  const [grid, setGrid] = useState(true);
  const [compass, setCompass] = useState(true);
  const [includeUserData, setIncludeUserData] = useState(true);

  const settings = useSettingsStore.getState();
  const optionsNow: MakeMapOptions = {
    name: name.trim() || 'My map',
    format,
    basemap,
    contours,
    contourIntervalM: settings.terrainContourIntervalM,
    slope,
    slopeMinDeg: settings.terrainSlopeMinDeg,
    slopeMaxDeg: settings.terrainSlopeMaxDeg,
    slopeOpacity,
    includeUserData,
    markedTrails,
    markedTrailsOpacity,
    grid,
    compass,
    declinationDeg: null, // filled in by makeMap at compose time
  };

  const preview = useMakeMapPreview(bbox, optionsNow);

  if (progress) {
    const value = PHASE_BASE[progress.phase] + progress.frac / 3;
    return (
      <Surface style={styles.progressSheet} elevation={4}>
        <Text variant="titleSmall" style={styles.title}>
          Making “{name}”
        </Text>
        <Text variant="bodySmall" style={styles.phase}>
          {PHASE_LABEL[progress.phase]}
        </Text>
        <ProgressBar progress={value} style={styles.bar} />
        <View style={styles.actions}>
          <Button mode="outlined" onPress={onCancel} style={styles.actionBtn}>
            Cancel
          </Button>
        </View>
      </Surface>
    );
  }

  const caption = [
    preview.scaleDenom > 0 ? `1:${preview.scaleDenom.toLocaleString('en-US')}` : null,
    contours && preview.contourIntervalM > 0 ? `${preview.contourIntervalM} m contours` : null,
    format.toUpperCase(),
  ]
    .filter(Boolean)
    .join(' · ');

  const row = (label: string, value: boolean, toggle: () => void) => (
    <View style={styles.optRow}>
      <Text variant="bodyMedium">{label}</Text>
      <Switch value={value} onValueChange={toggle} />
    </View>
  );

  return (
    <View style={styles.fill} pointerEvents="box-none">
      {/* The desk: dimmed stage with the page proof centred on it. */}
      <View style={[styles.desk, { backgroundColor: theme.dark ? '#26232c' : '#d9d3c6' }]}>
        <View style={styles.pageShadow}>
          <View style={styles.pageSheet}>
            {preview.uri ? (
              <Image
                source={{ uri: preview.uri }}
                style={styles.pageImage}
                resizeMode="cover"
                accessibilityLabel="Map preview"
              />
            ) : (
              <View style={styles.pageEmpty} />
            )}
          </View>
        </View>
        {preview.loading && (
          <View style={styles.previewSpinner} pointerEvents="none">
            <ActivityIndicator size="small" />
          </View>
        )}
        <Text variant="labelMedium" style={styles.deskCaption}>
          {preview.error ? 'Preview unavailable — check connection' : caption}
        </Text>
      </View>

      {/* The drawer: tabbed controls + actions. A plain View, NOT paper's
          Surface: Surface's iOS shadow nesting leaves its content wrapper
          unconstrained, collapsing the flex column (actions jumped under the
          tabs and the rows vanished). */}
      <View
        style={[
          styles.drawer,
          { backgroundColor: theme.colors.elevation?.level2 ?? theme.colors.surface },
        ]}
      >
        <SegmentedButtons
          value={tab}
          onValueChange={(v) => setTab(v as DrawerTab)}
          density="small"
          buttons={[
            { value: 'layers', label: 'Layers' },
            { value: 'page', label: 'Page' },
            { value: 'extras', label: 'Extras' },
          ]}
          style={styles.tabs}
        />
        <ScrollView style={styles.drawerScroll} contentContainerStyle={styles.drawerInner}>
          {tab === 'layers' && (
            <>
              {row('Contour lines', contours, () => setContours(!contours))}
              {row('Slope shading', slope, () => setSlope(!slope))}
              {slope && (
                <View style={styles.sliderRow}>
                  <DetentSlider
                    detents={OPACITY_DETENTS}
                    selected={slopeOpacity}
                    onSelect={setSlopeOpacity}
                  />
                </View>
              )}
              {row('Marked trails (Waymarked)', markedTrails, () => setMarkedTrails(!markedTrails))}
              {markedTrails && (
                <View style={styles.sliderRow}>
                  <DetentSlider
                    detents={OPACITY_DETENTS}
                    selected={markedTrailsOpacity}
                    onSelect={setMarkedTrailsOpacity}
                  />
                </View>
              )}
            </>
          )}
          {tab === 'page' && (
            <>
              <TextInput
                mode="outlined"
                dense
                label="Map name"
                defaultValue={name}
                onChangeText={setName}
                style={styles.nameInput}
              />
              <SegmentedButtons
                value={basemap}
                onValueChange={(v) => setBasemap(v as DrapeSource)}
                density="small"
                buttons={[
                  { value: 'map', label: 'Map' },
                  { value: 'satellite', label: 'Satellite' },
                ]}
                style={styles.rowGap}
              />
              <SegmentedButtons
                value={format}
                onValueChange={(v) => setFormat(v as 'a4' | 'letter')}
                density="small"
                buttons={[
                  { value: 'a4', label: 'A4' },
                  { value: 'letter', label: 'Letter' },
                ]}
                style={styles.rowGap}
              />
            </>
          )}
          {tab === 'extras' && (
            <>
              {row('Gridlines', grid, () => setGrid(!grid))}
              {row('Compass (true & magnetic north)', compass, () => setCompass(!compass))}
              {row('My tracks & waypoints', includeUserData, () =>
                setIncludeUserData(!includeUserData),
              )}
            </>
          )}
        </ScrollView>
        <View style={styles.actions}>
          <Button mode="outlined" onPress={onCancel} style={styles.actionBtn}>
            Cancel
          </Button>
          <Button mode="contained" style={styles.actionBtn} onPress={() => onCreate(optionsNow)}>
            Create
          </Button>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill, zIndex: 10 },
  desk: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: '46%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 34,
  },
  pageShadow: {
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  pageSheet: {
    width: 210,
    aspectRatio: 3 / 4.05,
    backgroundColor: '#ffffff',
    padding: 5,
    borderRadius: 2,
  },
  pageImage: { flex: 1 },
  pageEmpty: { flex: 1, backgroundColor: '#eee' },
  previewSpinner: { position: 'absolute', top: 42, right: 22 },
  deskCaption: { marginTop: 10, opacity: 0.9, color: '#efe9dc' },
  drawer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    top: '55%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 14,
    paddingBottom: 10,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: -4 },
  },
  tabs: { marginBottom: 6 },
  drawerScroll: { flex: 1 },
  drawerInner: { gap: 2, paddingBottom: 6 },
  optRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  sliderRow: { paddingLeft: 8, paddingBottom: 6 },
  nameInput: { marginBottom: 8 },
  rowGap: { marginVertical: 4 },
  progressSheet: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    borderRadius: 16,
    padding: 14,
    gap: 8,
    zIndex: 10,
  },
  title: { textAlign: 'center' },
  phase: { textAlign: 'center' },
  bar: { marginVertical: 10, height: 6, borderRadius: 3 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 8 },
  actionBtn: { minWidth: 110 },
});
