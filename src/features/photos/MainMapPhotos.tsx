import type { TrackSummary } from '@core/models';
import { mainMapPhotoChipLabel, mapPhotos } from '@core/photos/mapStyle';
import type { TrackPhoto } from '@core/photos/model';
import { mainMapPhotoMinZoom } from '@core/photos/settings';
import { useSettingsStore } from '@state/settingsStore';
import { useTrailPhotosStore } from '@state/trailPhotosStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { TrailPhotoLayers } from './TrailPhotoLayers';

/**
 * Trail photos on the main map (#587, owner Q1/Q2): the photos of the trails
 * shown on the map, from z12 by default (Settings → Photos → "Photo circles
 * appear"), and a chip that names them and hides or shows them.
 *
 * Only trails whose library summary says they have photos are read
 * (`TrackSummary.photoCount`, kept in step by the trail-photo store), so a
 * library of hundreds of shown trails never reads hundreds of sidecars.
 */

export interface MainMapTrailPhotos {
  trackId: string;
  name: string;
  photos: readonly TrackPhoto[];
}

export interface MainMapPhotosState {
  /** The zoom photos start at, or null when they are off. */
  minZoom: number | null;
  trails: readonly MainMapTrailPhotos[];
  /** The chip's text, or null when there is nothing to show. */
  label: string | null;
  /** Hidden from the chip for this session. */
  hidden: boolean;
  toggleHidden: () => void;
}

const NO_TRAILS: readonly MainMapTrailPhotos[] = [];

export function useMainMapPhotos(
  shownTrackIds: readonly string[],
  tracks: readonly TrackSummary[],
): MainMapPhotosState {
  const photosOnMainMap = useSettingsStore((s) => s.photosOnMainMap);
  const appear = useSettingsStore((s) => s.photoCirclesAppear);
  const minZoom = mainMapPhotoMinZoom(photosOnMainMap, appear);
  const [hidden, setHidden] = useState(false);
  const toggleHidden = useCallback(() => setHidden((h) => !h), []);

  const candidates = useMemo(() => {
    if (minZoom === null) return [];
    const shown = new Set(shownTrackIds);
    return tracks.filter((t) => shown.has(t.id) && (t.photoCount ?? 0) > 0);
  }, [minZoom, shownTrackIds, tracks]);

  useEffect(() => {
    const store = useTrailPhotosStore.getState();
    for (const t of candidates) void store.load(t.id);
  }, [candidates]);

  const byTrack = useTrailPhotosStore((s) => s.byTrack);
  const trails = useMemo(() => {
    if (candidates.length === 0) return NO_TRAILS;
    const out: MainMapTrailPhotos[] = [];
    for (const t of candidates) {
      const photos = byTrack[t.id]?.photos;
      if (photos && photos.length > 0) out.push({ trackId: t.id, name: t.name, photos });
    }
    return out;
  }, [candidates, byTrack]);

  const label = useMemo(
    () =>
      mainMapPhotoChipLabel(
        trails.map((t) => ({ name: t.name, count: mapPhotos(t.photos).length })),
      ),
    [trails],
  );

  return useMemo(
    () => ({ minZoom, trails, label, hidden, toggleHidden }),
    [minZoom, trails, label, hidden, toggleHidden],
  );
}

/** The photo layers, one instance per trail; render inside the main `<Map>`. */
export function MainMapPhotoLayers({
  state,
  onOpenPhoto,
  deferPress,
  getZoom,
  zoomTo,
}: {
  state: MainMapPhotosState;
  onOpenPhoto: (trackId: string, photoId: string) => void;
  deferPress: (run: () => void) => void;
  getZoom: () => Promise<number>;
  zoomTo: (center: [number, number], zoom: number) => void;
}) {
  if (state.minZoom === null || state.hidden) return null;
  return (
    <>
      {state.trails.map((t) => (
        <TrailLayers
          key={t.trackId}
          trail={t}
          minZoom={state.minZoom ?? 0}
          onOpenPhoto={onOpenPhoto}
          deferPress={deferPress}
          getZoom={getZoom}
          zoomTo={zoomTo}
        />
      ))}
    </>
  );
}

function TrailLayers({
  trail,
  minZoom,
  onOpenPhoto,
  deferPress,
  getZoom,
  zoomTo,
}: {
  trail: MainMapTrailPhotos;
  minZoom: number;
  onOpenPhoto: (trackId: string, photoId: string) => void;
  deferPress: (run: () => void) => void;
  getZoom: () => Promise<number>;
  zoomTo: (center: [number, number], zoom: number) => void;
}) {
  const { trackId } = trail;
  const onPhotoPress = useCallback(
    (ids: string[]) => {
      const first = ids[0];
      if (first) onOpenPhoto(trackId, first);
    },
    [trackId, onOpenPhoto],
  );
  return (
    <TrailPhotoLayers
      id={`main-${trackId}`}
      photos={trail.photos}
      minZoom={minZoom}
      onPhotoPress={onPhotoPress}
      deferPress={deferPress}
      getZoom={getZoom}
      zoomTo={zoomTo}
    />
  );
}

/** The chip (mockups 1–2): what the circles are, and a tap to hide or show them. */
export function MainMapPhotoChip({
  label,
  hidden,
  onToggle,
}: {
  label: string;
  hidden: boolean;
  onToggle: () => void;
}) {
  const t = useSchemeTokens();
  const ink = hidden ? t.map.chipInkMuted : t.map.chipInk;
  return (
    <View style={styles.row} pointerEvents="box-none">
      <Pressable
        onPress={onToggle}
        accessibilityRole="switch"
        accessibilityState={{ checked: !hidden }}
        accessibilityLabel={`${label}. ${hidden ? 'Show' : 'Hide'} photos on the map`}
        style={({ pressed }) => [
          styles.chip,
          { backgroundColor: t.map.chip, opacity: pressed ? 0.8 : 1 },
        ]}
        hitSlop={6}
        testID="main-map-photo-chip"
      >
        <Icon source={hidden ? 'camera-off-outline' : 'camera-outline'} size={15} color={ink} />
        <Text style={[styles.text, { color: ink }]} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 280,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
  },
  text: { fontSize: 12.5, fontWeight: '700', flexShrink: 1 },
});
