import type { BoundingBox } from '@core/models';
import { type MapBasemap, useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from '@ui/paper';
import { RegionPreviewThumb } from '../RegionPreviewThumb';
import { SubPanelButton, useSheetAccent, useSheetWidth } from './mapSheet';
import { useScaledStyles, useDisplayScale } from '@ui/displayScale';

/**
 * The base-map choices (#484, owner's option A). Relief was retired as a base
 * map; "trails and names over the imagery" is the Satellite sub-panel's
 * "Labels on satellite", not a base-map variant.
 */
export const MAP_TYPES: readonly { key: MapBasemap; label: string; description: string }[] = [
  { key: 'map', label: 'Map', description: 'Trails, contours, names' },
  { key: 'satellite', label: 'Satellite', description: 'Aerial imagery' },
];

/** Card preview height (#669: compact, 74 dp), and the ring of the selected card. */
const PREVIEW_H = 74;
const RING = 3;
const CARD_GAP = 12;
const SHEET_PAD = 16;

/**
 * A small box around wherever the user last was, so a preview shows THEIR
 * terrain, not a canned sample; null (never located) gives the thumb's
 * placeholder glyph.
 */
export function usePreviewBbox(): BoundingBox | null {
  const lastKnown = useSettingsStore((s) => s.lastKnownPosition);
  return useMemo<BoundingBox | null>(
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
}

/**
 * The base map, first in Map layers › Terrain (#669; it was the rail's "Base
 * map" panel): one compact card per base map with a live preview of the
 * user's own area, the selection marked by an accent ring and a check.
 * Tapping a card switches the base map and leaves the sheet open. Satellite
 * carries the sub-panel accessory (labels, imagery brightness); Map has no
 * options of its own.
 *
 * A11y: each card is one selectable button named "<label>, <description>"
 * (never a bare 'Map', which the tab bar's Map tab already owns).
 */
export function BaseMapCards({ onOpenSatellite }: { onOpenSatellite: () => void }) {
  const { sz } = useDisplayScale();

  const styles = useScaledStyles(stylesSheet);

  const tokens = useSchemeTokens();
  const { accent, onAccent } = useSheetAccent();
  const basemap = useMapStore((s) => s.basemap);
  const setBasemap = useMapStore((s) => s.setBasemap);
  const tileUrl = useSettingsStore((s) => s.tileUrl);
  const bbox = usePreviewBbox();
  const cardW = Math.floor((useSheetWidth() - 2 * SHEET_PAD - CARD_GAP) / 2);

  return (
    <View style={styles.cards}>
      {MAP_TYPES.map((t) => {
        const selected = basemap === t.key;
        return (
          <View key={t.key} style={{ width: cardW }}>
            <Pressable
              onPress={() => setBasemap(t.key)}
              accessibilityRole="button"
              accessibilityLabel={`${t.label}, ${t.description}`}
              accessibilityState={{ selected }}
            >
              <View
                style={[styles.preview, { borderColor: selected ? accent : tokens.outlineVariant }]}
              >
                <RegionPreviewThumb
                  bbox={bbox}
                  basemap={t.key}
                  tileUrl={tileUrl}
                  size={PREVIEW_H - 2 * RING}
                  width={cardW - 2 * RING}
                  height={PREVIEW_H - 2 * RING}
                  radius={sz(11)}
                />
                {selected && (
                  <View style={[styles.check, { backgroundColor: accent }]} testID="map-type-check">
                    <Icon source="check" size={16} color={onAccent} />
                  </View>
                )}
              </View>
            </Pressable>
            <View style={styles.caption}>
              <View style={styles.captionText}>
                <Text style={[styles.cardLabel, { color: tokens.ink }]} numberOfLines={1}>
                  {t.label}
                </Text>
                <Text style={[styles.cardSub, { color: tokens.inkMuted }]} numberOfLines={1}>
                  {t.description}
                </Text>
              </View>
              {t.key === 'satellite' && (
                <SubPanelButton
                  onPress={onOpenSatellite}
                  accessibilityLabel="Options for Satellite"
                />
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const stylesSheet = StyleSheet.create({
  cards: {
    flexDirection: 'row',
    gap: CARD_GAP,
    paddingHorizontal: SHEET_PAD,
    paddingTop: 4,
    paddingBottom: 8,
  },
  preview: {
    height: PREVIEW_H,
    borderRadius: 14,
    borderWidth: RING,
    overflow: 'hidden',
  },
  check: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  caption: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, minHeight: 36 },
  captionText: { flex: 1, minWidth: 0 },
  cardLabel: { fontSize: 15, lineHeight: 20, fontWeight: '800', paddingLeft: 2 },
  cardSub: { fontSize: 12, lineHeight: 16, paddingLeft: 2 },
});
