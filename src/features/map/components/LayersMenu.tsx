import type { BoundingBox } from '@core/models';
import { type MapBasemap, useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { RegionPreviewThumb } from '../RegionPreviewThumb';
import { MapSheet, SheetHeader, useSheetAccent, useSheetWidth } from './mapSheet';

/**
 * The base-map choices (#484, owner's option A): two big cards. Relief was
 * retired as a base map; "trails and names over the imagery" is an overlay
 * now (Overlays → Labels on satellite), not a base-map variant.
 */
export const MAP_TYPES: readonly { key: MapBasemap; label: string; description: string }[] = [
  { key: 'map', label: 'Map', description: 'Trails, contours, names' },
  { key: 'satellite', label: 'Satellite', description: 'Aerial imagery' },
];

/** Card preview height, and the ring that marks the selected card. */
const PREVIEW_H = 120;
const RING = 3;
const CARD_GAP = 12;
const SHEET_PAD = 16;

/**
 * The "Map type" panel (#484, mockup `PickerA`): a themed sheet unfolding
 * under the rail's Base map button with one large preview card per base map
 * — a live tile of the user's own area in that style (same cached-tile
 * previews as the download sheet) — the selection marked by an accent ring
 * and a check badge. Picking a card switches the base map and closes the
 * panel; ✕ or an outside tap (the rail's backdrop) closes it untouched.
 *
 * A11y: each card is one selectable button named "<label>, <description>"
 * (never a bare 'Map', which the tab bar's Map tab already owns).
 */
export function MapTypePanel({ onClose }: { onClose: () => void }) {
  const tokens = useSchemeTokens();
  const { accent, onAccent } = useSheetAccent();
  const basemap = useMapStore((s) => s.basemap);
  const setBasemap = useMapStore((s) => s.setBasemap);
  const tileUrl = useSettingsStore((s) => s.tileUrl);
  const lastKnown = useSettingsStore((s) => s.lastKnownPosition);
  const cardW = Math.floor((useSheetWidth() - 2 * SHEET_PAD - CARD_GAP) / 2);

  // Preview region: a small box around wherever the user last was — the
  // preview shows THEIR terrain, not a canned sample. Null (never located)
  // degrades to the thumb's placeholder glyph.
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
    <MapSheet>
      <SheetHeader title="Map type" closeLabel="Close map type" onClose={onClose} />
      <View style={styles.cards}>
        {MAP_TYPES.map((t) => {
          const selected = basemap === t.key;
          return (
            <Pressable
              key={t.key}
              onPress={() => {
                setBasemap(t.key);
                onClose();
              }}
              accessibilityRole="button"
              accessibilityLabel={`${t.label}, ${t.description}`}
              accessibilityState={{ selected }}
              style={[styles.card, { width: cardW }]}
            >
              <View
                style={[styles.preview, { borderColor: selected ? accent : tokens.outlineVariant }]}
              >
                <RegionPreviewThumb
                  bbox={thumbBbox}
                  basemap={t.key}
                  tileUrl={tileUrl}
                  size={PREVIEW_H - 2 * RING}
                  width={cardW - 2 * RING}
                  height={PREVIEW_H - 2 * RING}
                  radius={13}
                />
                {selected && (
                  <View style={[styles.badge, { backgroundColor: accent }]} testID="map-type-check">
                    <Icon source="check" size={16} color={onAccent} />
                  </View>
                )}
              </View>
              <Text style={[styles.cardLabel, { color: tokens.ink }]} numberOfLines={1}>
                {t.label}
              </Text>
              <Text style={[styles.cardSub, { color: tokens.inkMuted }]} numberOfLines={1}>
                {t.description}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </MapSheet>
  );
}

const styles = StyleSheet.create({
  cards: {
    flexDirection: 'row',
    gap: CARD_GAP,
    paddingHorizontal: SHEET_PAD,
    paddingTop: 6,
    paddingBottom: 8,
  },
  card: { gap: 2 },
  preview: {
    height: PREVIEW_H,
    borderRadius: 16,
    borderWidth: RING,
    overflow: 'hidden',
    marginBottom: 6,
  },
  badge: {
    position: 'absolute',
    top: 7,
    right: 7,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardLabel: { fontSize: 16, lineHeight: 21, fontWeight: '800', paddingLeft: 2 },
  cardSub: { fontSize: 13, lineHeight: 17, paddingLeft: 2 },
});
