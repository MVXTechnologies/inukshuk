import {
  WHITE_KEY_LEVELS,
  nearestWhiteKeyLevel,
  whiteKeyLabel,
  whiteKeyStrength,
  type WhiteKeyLevel,
} from '@core/geo/pdfWhiteKey';
import { useSettingsStore } from '@state/settingsStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { StyleSheet, View } from 'react-native';
import { Text } from '@ui/paper';
import Svg, { Path } from 'react-native-svg';
import { RegionPreviewThumb } from '../RegionPreviewThumb';
import { usePreviewBbox } from './BaseMapCards';
import {
  ControlRow,
  SheetNote,
  SubPanelHeader,
  SwitchRow,
  useSheetAccent,
  useSheetWidth,
} from './mapSheet';
import { StepSlider } from './StepSlider';
import { useScaledStyles, useDisplayScale } from '@ui/displayScale';

/** See-through white's slider stops: Off, 25 %, 50 %, 75 %, 100 %. */
const WHITE_KEY_STOPS = WHITE_KEY_LEVELS.map(whiteKeyLabel);
/** The `below` indent of a sheet row (see mapSheet), left + right. */
const BELOW_INSET = 52 + 16;
/** The slider's value label + its gap, beside the track. */
const VALUE_W = 74;
const SAMPLE_H = 56;
/** What the second sample shows while the setting is Off: the middle stop. */
const SAMPLE_WHEN_OFF: WhiteKeyLevel = 2;
/** A printed trail and a contour on white paper (fixed in both themes: they are the sheet's). */
const TRAIL_INK = palette.route;
const CONTOUR_INK = palette.ochre;
const PAPER = palette.white;

/** The sample's print: the same trail and contour on both swatches. */
function Print() {
  return (
    <Svg width="100%" height="100%" viewBox="0 0 120 56" preserveAspectRatio="none">
      <Path d="M0 40 C30 20 60 50 120 22" stroke={TRAIL_INK} strokeWidth={2} fill="none" />
      <Path d="M0 18 C40 30 80 6 120 14" stroke={CONTOUR_INK} strokeWidth={1} fill="none" />
    </Svg>
  );
}

/**
 * Map layers › Map › PDF maps (#670): the PDF maps' switch, then See-through
 * white — how see-through a sheet's white paper is, so the base map shows
 * through open land and margins (`@core/geo/pdfWhiteKey`) — always enabled
 * (the owner's sub-menu rule: it can be set while the maps are hidden). A
 * before/after sample shows what it does over the user's own area. It is the
 * default for every PDF map; a map overrides it from its Library ⋮ menu.
 */
export function PdfMapsPanel({ onBack }: { onBack: () => void }) {
  // #760: drawings sized in dp follow the Display size.
  const { sz: dsz } = useDisplayScale();
  const { sz } = useDisplayScale();

  const styles = useScaledStyles(stylesSheet);

  const tokens = useSchemeTokens();
  const { accent } = useSheetAccent();
  const show = useSettingsStore((s) => s.showPdfOverlay);
  const level = useSettingsStore((s) => s.pdfWhiteKey);
  const tileUrl = useSettingsStore((s) => s.tileUrl);
  const set = useSettingsStore((s) => s.set);
  const bbox = usePreviewBbox();
  const sheetW = useSheetWidth();
  const sampleW = Math.floor((sheetW - 32 - 10) / 2);
  const sample = level === 0 ? SAMPLE_WHEN_OFF : level;

  return (
    <>
      <SubPanelHeader title="PDF maps" backLabel="Back to overlays" onBack={onBack} />
      <SwitchRow
        icon="map-legend"
        label="Show PDF maps"
        hint={show ? 'Your imported and made maps' : 'Hidden on the map'}
        value={show}
        onToggle={() => set('showPdfOverlay', !show)}
      />
      <ControlRow
        icon="circle-opacity"
        label="See-through white"
        hint="See the map below white areas"
      >
        <StepSlider
          labels={WHITE_KEY_STOPS}
          value={level}
          onChange={(stop) => set('pdfWhiteKey', nearestWhiteKeyLevel(stop))}
          width={sheetW - BELOW_INSET - VALUE_W}
          accessibilityLabel="See-through white"
          accentColor={accent}
          trackColor={tokens.surfaceVariant}
          tickColor={tokens.inkMuted}
        />
      </ControlRow>
      <View
        style={styles.samples}
        accessible
        accessibilityLabel={`Sample: paper white, and ${whiteKeyLabel(sample)} with the base map showing through`}
      >
        <View style={{ width: sampleW }}>
          <View
            style={[styles.swatch, { backgroundColor: PAPER, borderColor: tokens.outlineVariant }]}
          >
            <Print />
          </View>
          <Text style={[styles.caption, { color: tokens.inkMuted }]} numberOfLines={1}>
            Off · paper white
          </Text>
        </View>
        <View style={{ width: sampleW }}>
          <View style={[styles.swatch, { borderColor: tokens.outlineVariant }]}>
            <RegionPreviewThumb
              bbox={bbox}
              basemap="map"
              tileUrl={tileUrl}
              size={dsz(SAMPLE_H) - 2}
              width={sampleW - 2}
              height={dsz(SAMPLE_H) - 2}
              radius={sz(9)}
            />
            {/* The white left on the paper at this stop. */}
            <View
              testID="pdf-sample-paper"
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: PAPER, opacity: 1 - whiteKeyStrength(sample) },
              ]}
            />
            <View style={StyleSheet.absoluteFill}>
              <Print />
            </View>
          </View>
          <Text style={[styles.caption, { color: tokens.inkMuted }]} numberOfLines={1}>
            {`${whiteKeyLabel(sample)} · base map shows`}
          </Text>
        </View>
      </View>
      <SheetNote icon="tune">
        The default for every PDF map. A map can override it: Library › the map’s ⋮ › See-through
        white.
      </SheetNote>
    </>
  );
}

const stylesSheet = StyleSheet.create({
  samples: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingBottom: 4 },
  swatch: { height: SAMPLE_H, borderRadius: 10, borderWidth: 1, overflow: 'hidden' },
  caption: { fontSize: 11.5, lineHeight: 15, marginTop: 3 },
});
