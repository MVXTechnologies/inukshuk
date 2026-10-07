/**
 * A tapped photo as a bottom card (owner 2026-10-07: "not another page"):
 * the photo, its caption, when and where on the trail, the team's latest
 * comment, and actions. The map stays visible above it. Swipe down to close;
 * swipe up (or tap the photo) for the full-screen viewer, its expanded state.
 * A plain themed View (paper-surface-ios-flex-collapse).
 */
import type { TrackPhoto } from '@core/photos/model';
import { trailUrl } from '@core/teamui/alerts';
import { useTeamStore } from '@state/teamStore';
import { useTrailPhotosStore } from '@state/trailPhotosStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo } from 'react';
import { Image, PanResponder, Pressable, StyleSheet, View } from 'react-native';
import { Icon, IconButton, Text } from 'react-native-paper';
import { create } from 'zustand';

import { formatPhotoWhen } from './photoText';
import { photoFileUri, photoViewerHref } from './photoUri';

export type PhotoCardTarget =
  | { kind: 'own'; trackId: string; photoId: string }
  | { kind: 'team'; owner: string; trackId: string; photoId: string };

export const usePhotoCard = create<{
  target: PhotoCardTarget | null;
  /** Bumped by a swipe up: the card opens the full-screen viewer. */
  expandAt: number;
  show: (t: PhotoCardTarget) => void;
  close: () => void;
  expand: () => void;
}>((set) => ({
  target: null,
  expandAt: 0,
  show: (target) => set({ target }),
  close: () => set({ target: null }),
  expand: () => set({ expandAt: Date.now() }),
}));

const SWIPE = 40;

export function PhotoBottomCard() {
  const t = useSchemeTokens();
  const router = useRouter();
  const target = usePhotoCard((s) => s.target);
  const close = usePhotoCard((s) => s.close);
  const own = useTrailPhotosStore((s) =>
    target?.kind === 'own'
      ? s.byTrack[target.trackId]?.photos.find((p) => p.id === target.photoId)
      : undefined,
  );
  const teamPhoto = useTeamStore((s) =>
    target ? s.photos.find((p) => p.id === target.photoId) : undefined,
  );
  const threads = useTeamStore((s) => s.photoThreads);
  const view = useTeamStore((s) => s.view);

  const expandAt = usePhotoCard((s) => s.expandAt);
  const full = useCallback(() => {
    if (!target) return;
    close();
    if (target.kind === 'own')
      router.push(photoViewerHref(target.trackId, target.photoId) as never);
    else
      router.push(trailUrl(target.owner, target.trackId, view?.me ?? '', target.photoId) as never);
  }, [target, close, router, view?.me]);
  useEffect(() => {
    if (expandAt > 0) full();
    // Only a new swipe up expands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandAt]);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dy) > 8 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderRelease: (_e, g) => {
          if (g.dy > SWIPE) usePhotoCard.getState().close();
          else if (g.dy < -SWIPE) usePhotoCard.getState().expand();
        },
      }),
    [],
  );
  if (target === null) return null;
  const photo: Pick<TrackPhoto, 'caption' | 'takenAt'> & { uri: string | null; km: number | null } =
    own
      ? {
          caption: own.caption,
          takenAt: own.takenAt,
          uri: photoFileUri(own.thumb),
          km: own.distanceM / 1000,
        }
      : {
          caption: teamPhoto?.caption ?? undefined,
          takenAt: teamPhoto?.takenAt ?? undefined,
          uri: teamPhoto?.thumbUri ?? null,
          km: null,
        };
  const said = threads.get(target.photoId) ?? [];
  const last = said.length > 0 ? said[said.length - 1] : undefined;
  const author = last ? view?.members.find((m) => m.id === last.author)?.name : undefined;
  const sub = [
    photo.takenAt ? formatPhotoWhen(photo.takenAt) : null,
    photo.km !== null ? `km ${photo.km.toFixed(1)}` : null,
    said.length > 0 ? `${said.length} comment${said.length === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <View
      style={[styles.card, { backgroundColor: t.elevation.level2, shadowColor: palette.shadow }]}
      {...pan.panHandlers}
      testID="photo-card"
    >
      <View style={[styles.grabber, { backgroundColor: t.outlineVariant }]} />
      <View style={styles.row}>
        <Pressable
          onPress={() => full()}
          accessibilityRole="imagebutton"
          accessibilityLabel="Open the photo full screen"
          testID="photo-card-image"
        >
          {photo.uri ? (
            <Image source={{ uri: photo.uri }} style={styles.thumb} />
          ) : (
            <View style={[styles.thumb, { backgroundColor: t.surfaceVariant }]} />
          )}
        </Pressable>
        <View style={styles.flex}>
          <Text variant="titleSmall" style={{ color: t.ink }} numberOfLines={2}>
            {photo.caption ?? 'Photo'}
          </Text>
          {sub ? (
            <Text variant="bodySmall" style={{ color: t.inkVariant }} numberOfLines={2}>
              {sub}
            </Text>
          ) : null}
          {last && (
            <Text variant="bodySmall" style={{ color: t.ink }} numberOfLines={1}>
              {`${author ?? 'A teammate'}: …`}
            </Text>
          )}
        </View>
        <View>
          <IconButton icon="close" size={20} onPress={close} accessibilityLabel="Close" />
          <IconButton
            icon="arrow-expand"
            size={20}
            onPress={() => full()}
            accessibilityLabel="Full screen"
            testID="photo-card-full"
          />
        </View>
      </View>
      <View style={styles.hint}>
        <Icon source="gesture-swipe-vertical" size={14} color={t.inkMuted} />
        <Text variant="labelSmall" style={{ color: t.inkMuted }}>
          Swipe up for the photo and its comments · down to close
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 2 },
  card: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
    gap: 8,
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -2 },
    elevation: 8,
  },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  thumb: { width: 112, height: 84, borderRadius: 12 },
  hint: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'center' },
});
