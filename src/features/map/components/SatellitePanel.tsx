import { IMAGERY_LOOK_LABEL, IMAGERY_LOOKS } from '@core/map/satelliteImagery';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from '@ui/paper';
import { RegionPreviewThumb } from '../RegionPreviewThumb';
import { usePreviewBbox } from './BaseMapCards';
import {
  LevelsRow,
  SheetNote,
  SubPanelHeader,
  SwitchRow,
  useSheetAccent,
  useSheetWidth,
} from './mapSheet';
import { useScaledStyles } from '@ui/displayScale';

const IMAGERY = IMAGERY_LOOKS.map((l) => ({ value: l, label: IMAGERY_LOOK_LABEL[l] }));
const STRIP_H = 84;
const RING = 3;

/**
 * Map layers › Terrain › Satellite (#669): the options that belong to the
 * Satellite base map alone — "Labels on satellite" and the imagery
 * brightness (#495) — never greyed out (the owner's sub-menu rule): they can
 * be set while Map is the base map and apply whenever Satellite is. The top
 * right says "Base map in use", or offers "Use" when it is not.
 */
export function SatellitePanel({ onBack }: { onBack: () => void }) {
  const styles = useScaledStyles(stylesSheet);

  const tokens = useSchemeTokens();
  const { accent } = useSheetAccent();
  const inUse = useMapStore((s) => s.basemap === 'satellite');
  const setBasemap = useMapStore((s) => s.setBasemap);
  const tileUrl = useSettingsStore((s) => s.tileUrl);
  const labels = useSettingsStore((s) => s.satelliteLabels);
  const imagery = useSettingsStore((s) => s.satelliteImagery);
  const set = useSettingsStore((s) => s.set);
  const bbox = usePreviewBbox();
  const stripW = useSheetWidth() - 32;

  return (
    <>
      <SubPanelHeader
        title="Satellite"
        backLabel="Back to overlays"
        onBack={onBack}
        right={
          inUse ? (
            <View style={styles.inUse} accessible accessibilityLabel="Base map in use">
              <Icon source="check-circle" size={18} color={tokens.inkMuted} />
              <Text style={[styles.inUseText, { color: tokens.inkMuted }]}>Base map in use</Text>
            </View>
          ) : (
            <Pressable
              onPress={() => setBasemap('satellite')}
              accessibilityRole="button"
              accessibilityLabel="Use Satellite as the base map"
              hitSlop={8}
            >
              <Text style={[styles.use, { color: accent }]}>Use</Text>
            </Pressable>
          )
        }
      />
      <View
        style={[styles.strip, { borderColor: inUse ? accent : tokens.outlineVariant }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <RegionPreviewThumb
          bbox={bbox}
          basemap="satellite"
          tileUrl={tileUrl}
          size={STRIP_H - 2 * RING}
          width={stripW - 2 * RING}
          height={STRIP_H - 2 * RING}
          radius={11}
          // Four tiles across, one zoom pair deeper: sharp at the strip's width.
          columns={4}
        />
      </View>
      <SwitchRow
        icon="label-outline"
        label="Labels on satellite"
        hint="Trails and names over imagery"
        value={labels}
        onToggle={() => set('satelliteLabels', !labels)}
      />
      <LevelsRow
        icon="brightness-6"
        label="Imagery"
        hint="Brightness under forest and shadow"
        levels={IMAGERY}
        selected={imagery}
        onSelect={(l) => set('satelliteImagery', l)}
      />
      <SheetNote icon="information-outline">
        Set these any time: they apply whenever Satellite is the base map.
      </SheetNote>
    </>
  );
}

const stylesSheet = StyleSheet.create({
  inUse: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  inUseText: { fontSize: 13.5, fontWeight: '700' },
  use: { fontSize: 15, fontWeight: '800' },
  strip: {
    height: STRIP_H,
    marginHorizontal: 16,
    marginTop: 2,
    marginBottom: 6,
    borderRadius: 14,
    borderWidth: RING,
    overflow: 'hidden',
  },
});
