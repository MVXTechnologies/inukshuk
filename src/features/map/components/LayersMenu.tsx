import type { BoundingBox } from '@core/models';
import { type MapBasemap, useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FAB, Icon, Menu, Text, TouchableRipple, useTheme } from 'react-native-paper';
import { RegionPreviewThumb } from '../RegionPreviewThumb';
import { EdgePill } from './EdgePill';

/** Base-map choices. */
const BASEMAPS: { key: MapBasemap; label: string }[] = [
  { key: 'relief', label: 'Relief' },
  { key: 'map', label: 'Map' },
  { key: 'satellite', label: 'Satellite' },
];

/**
 * The base-map rows (Relief / Map / Satellite), shared by the classic menu
 * and the edge rail's expanding panel — each with a small live thumbnail of
 * the user's own area in that style (same cached-tile previews as the
 * download sheet). Everything else that used to share this menu now lives in
 * the Overlays menu — the mountain button is ONLY about which ground you
 * stand on.
 */
export function BasemapRows({ onPicked }: { onPicked?: () => void }) {
  const theme = useTheme();
  const basemap = useMapStore((s) => s.basemap);
  const setBasemap = useMapStore((s) => s.setBasemap);
  const tileUrl = useSettingsStore((s) => s.tileUrl);
  const lastKnown = useSettingsStore((s) => s.lastKnownPosition);

  // Thumbnail region: a small box around wherever the user last was — the
  // preview should show THEIR terrain, not a canned sample. Null (never
  // located) degrades to the thumb's placeholder glyph.
  const thumbBbox = useMemo<BoundingBox | null>(
    () =>
      lastKnown
        ? {
            minLng: lastKnown.longitude - 0.02,
            maxLng: lastKnown.longitude + 0.02,
            minLat: lastKnown.latitude - 0.02,
            maxLat: lastKnown.latitude + 0.02,
          }
        : null,
    [lastKnown],
  );

  return (
    <>
      {BASEMAPS.map((b) => {
        const selected = basemap === b.key;
        return (
          <TouchableRipple
            key={b.key}
            onPress={() => {
              setBasemap(b.key);
              onPicked?.();
            }}
            accessibilityLabel={b.label}
            style={styles.bmRow}
          >
            <View style={styles.bmInner}>
              <View style={styles.bmLabelBox}>
                {selected && <Icon source="check" size={16} />}
                <Text variant="bodyLarge">{b.label}</Text>
              </View>
              {/* The banner: a thin, full-width strip of the user's own area
                  in this style. */}
              <View
                style={[
                  styles.bmBanner,
                  selected && { borderWidth: 2, borderColor: theme.colors.primary },
                ]}
              >
                <RegionPreviewThumb
                  bbox={thumbBbox}
                  basemap={b.key}
                  tileUrl={tileUrl}
                  size={30}
                  width={150}
                  height={30}
                />
              </View>
            </View>
          </TouchableRipple>
        );
      })}
    </>
  );
}

/**
 * The mountain FAB + base-map menu (classic/minimal styles; the edge rail
 * renders {@link BasemapRows} in its own expanding panel instead).
 */
export function BasemapMenu({ edgeAnchor }: { edgeAnchor?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      visible={open}
      onDismiss={() => setOpen(false)}
      anchor={
        edgeAnchor ? (
          <EdgePill icon="image-filter-hdr" label="Base map" onPress={() => setOpen(true)} />
        ) : (
          <FAB
            icon="image-filter-hdr"
            size="small"
            variant="surface"
            onPress={() => setOpen(true)}
            style={styles.controlFab}
            accessibilityLabel="Base map"
          />
        )
      }
    >
      <BasemapRows onPicked={() => setOpen(false)} />
    </Menu>
  );
}

const styles = StyleSheet.create({
  controlFab: { borderRadius: 24 },
  // minWidth stretches the row inside the content-sized paper Menu so the
  // banner is a real strip, not a sliver.
  bmRow: { paddingVertical: 7, paddingHorizontal: 12, minWidth: 308 },
  bmInner: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bmLabelBox: { flexDirection: 'row', alignItems: 'center', gap: 6, width: 110 },
  bmBanner: { flex: 1, borderRadius: 7, overflow: 'hidden', height: 30 },
});
