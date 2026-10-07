import { photoOrdinal } from '@core/photos/lane';
import { isNotePhoto, type TrackPhoto } from '@core/photos/model';
import { profilePaths, sampleProfile } from '@core/photos/profileSamples';
import { photoEditFailureMessage, photoListNotice } from '@core/photos/status';
import { photoFacts, viewerInfoText, type ViewerInfoText } from '@core/photos/viewerInfo';
import { formatDistance, formatElevation } from '@state/formatters';
import { usePhotoFocusStore } from '@state/photoFocusStore';
import { useSettingsStore } from '@state/settingsStore';
import { photosEditable, useTrailPhotosStore } from '@state/trailPhotosStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewToken,
} from 'react-native';
import {
  Button,
  Dialog,
  Icon,
  IconButton,
  Menu,
  Portal,
  Snackbar,
  Text,
  TextInput,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { useTimedSnackbar } from '../common/useTimedSnackbar';
import { formatPhotoWhen } from './photoText';
import { photoFileUri } from './photoUri';
import { useViewerTrail } from './useViewerTrail';
import { ZoomablePhoto } from './ZoomablePhoto';

/** Height of the info sheet's mini profile. */
const PROFILE_H = 44;
const THUMB = 52;

/**
 * The full-screen photo viewer (#587, mockup 03; route
 * `/photo/[trackId]/[photoId]`). Swipe between all of the trail's photos in
 * time order; pinch to zoom; drag down to close. The photo stage is always
 * black; the info sheet below follows the theme: what, when, where on the
 * outing (on the trail view's axis, so it matches the charts), a mini
 * profile, how the photo was placed, a filmstrip, and Show on map / Caption
 * / Share.
 *
 * Note photos (from trail notes) show here read-only. A photo list that
 * cannot be written over (newer app version, unreadable) blocks every edit
 * and says why.
 */
export function PhotoViewerScreen({ trackId, photoId }: { trackId: string; photoId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const t = useSchemeTokens();
  // Subscribed so a unit switch re-renders the distances.
  useSettingsStore((s) => s.units);
  const { track, photos, status, trail, indexCumM } = useViewerTrail(trackId);
  const [currentId, setCurrentId] = useState(photoId);
  const [zoomed, setZoomed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [captioning, setCaptioning] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stageH, setStageH] = useState(0);
  const { message, show, dismiss } = useTimedSnackbar(2500);
  const pager = useRef<FlatList<TrackPhoto>>(null);

  const index = Math.max(
    0,
    photos.findIndex((p) => p.id === currentId),
  );
  const photo: TrackPhoto | undefined = photos[index];
  const editable = photosEditable(status) && photo !== undefined && !isNotePhoto(photo);
  const notice = photoListNotice(status);

  // The photo went away (hidden, removed elsewhere) and nothing is left: close.
  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(`/trail3d/${trackId}` as never);
  }, [router, trackId]);
  useEffect(() => {
    if (status !== 'loading' && photos.length === 0) close();
  }, [status, photos.length, close]);

  // Keep the pager on the current photo when the list changes under it.
  const lastLen = useRef(0);
  useEffect(() => {
    if (photos.length === 0 || stageH === 0) return;
    if (lastLen.current !== photos.length) {
      lastLen.current = photos.length;
      pager.current?.scrollToIndex({ index, animated: false });
    }
  }, [photos.length, index, stageH]);

  // FlatList needs these two to keep their identity for its whole life.
  const [onViewable] = useState(
    () =>
      ({ viewableItems }: { viewableItems: ViewToken<TrackPhoto>[] }) => {
        const first = viewableItems[0]?.item;
        if (first) setCurrentId(first.id);
      },
  );
  const [viewability] = useState(() => ({ itemVisiblePercentThreshold: 60 }));

  const info: ViewerInfoText | null = useMemo(() => {
    if (!photo) return null;
    const facts =
      trail && indexCumM
        ? photoFacts(photo, trail, indexCumM)
        : { distanceM: photo.distanceM, direction: null };
    return viewerInfoText(photo, facts, {
      number: index + 1,
      totalM: trail?.totalM ?? photo.distanceM,
      isNote: isNotePhoto(photo),
      fmt: { formatDistance, formatElevation },
      formatWhen: formatPhotoWhen,
    });
  }, [photo, trail, indexCumM, index]);

  const cursorFrac = useMemo(() => {
    if (!photo || !trail || !indexCumM || trail.totalM <= 0) return null;
    return photoFacts(photo, trail, indexCumM).distanceM / trail.totalM;
  }, [photo, trail, indexCumM]);
  const profileW = width - 32;
  const profile = useMemo(
    () => (trail ? profilePaths(sampleProfile(trail), profileW, PROFILE_H) : null),
    [trail, profileW],
  );

  const goTo = (i: number) => {
    const next = photos[i];
    if (!next) return;
    setCurrentId(next.id);
    pager.current?.scrollToIndex({ index: i, animated: true });
  };

  const run = async (label: string, job: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await job();
    } catch (err) {
      show(photoEditFailureMessage(err, `Could not ${label}`));
    } finally {
      setBusy(false);
    }
  };

  const showOnMap = () => {
    if (!photo) return;
    usePhotoFocusStore.getState().focus(trackId, photo.id);
    router.dismissTo(`/trail3d/${trackId}` as never);
  };

  const share = async () => {
    if (!photo || isNotePhoto(photo)) return;
    if (!(await Sharing.isAvailableAsync())) {
      show('Sharing is not available on this device');
      return;
    }
    // The kept copy carries no location: a canvas re-encode, or a stripped original.
    await Sharing.shareAsync(photoFileUri(photo.file), {
      mimeType: 'image/jpeg',
      UTI: 'public.jpeg',
    });
  };

  const ordinal = photo ? photoOrdinal(photos, photo.id) : null;
  const stage = stageH > 0 ? stageH : 1;

  return (
    <View style={[styles.fill, { backgroundColor: 'black' }]} testID="photo-viewer">
      <StatusBar style="light" />
      <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
        <IconButton
          icon="close"
          iconColor={palette.white}
          onPress={close}
          accessibilityLabel="Close"
        />
        <Text style={styles.counter} testID="photo-viewer-counter">
          {ordinal ? `${ordinal.n} of ${ordinal.of}` : ''}
        </Text>
        <Menu
          visible={menuOpen}
          onDismiss={() => setMenuOpen(false)}
          anchor={
            <IconButton
              icon="dots-vertical"
              iconColor={palette.white}
              disabled={!editable || busy}
              onPress={() => setMenuOpen(true)}
              accessibilityLabel="More photo actions"
            />
          }
        >
          <Menu.Item
            leadingIcon={photo?.hidden ? 'eye-outline' : 'eye-off-outline'}
            title={photo?.hidden ? 'Show on the map again' : 'Hide from map'}
            onPress={() => {
              setMenuOpen(false);
              if (photo) {
                const hidden = !photo.hidden;
                void run(hidden ? 'hide the photo' : 'show the photo', async () => {
                  await useTrailPhotosStore.getState().editPhoto(trackId, photo.id, { hidden });
                  show(hidden ? 'Hidden from the map' : 'Back on the map');
                });
              }
            }}
          />
          <Menu.Item
            leadingIcon="trash-can-outline"
            title="Remove from trail"
            onPress={() => {
              setMenuOpen(false);
              setConfirmRemove(true);
            }}
          />
        </Menu>
      </View>

      <View style={styles.fill} onLayout={(e) => setStageH(e.nativeEvent.layout.height)}>
        {stageH > 0 && (
          <FlatList
            ref={pager}
            data={photos}
            keyExtractor={(p) => p.id}
            horizontal
            pagingEnabled
            scrollEnabled={!zoomed}
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={index}
            getItemLayout={(_d, i) => ({ length: width, offset: width * i, index: i })}
            onViewableItemsChanged={onViewable}
            viewabilityConfig={viewability}
            windowSize={3}
            initialNumToRender={1}
            maxToRenderPerBatch={2}
            renderItem={({ item, index: i }) => (
              <View style={{ width, height: stage }}>
                <ZoomablePhoto
                  uri={photoFileUri(item.file)}
                  width={width}
                  height={stage}
                  onZoomChange={setZoomed}
                  onDismiss={close}
                  accessibilityLabel={`Photo ${i + 1} of ${photos.length}${
                    item.caption ? `: ${item.caption}` : ''
                  }`}
                />
              </View>
            )}
          />
        )}
      </View>

      {info && photo && (
        <View
          style={[styles.sheet, { backgroundColor: t.surface, paddingBottom: insets.bottom + 12 }]}
          testID="photo-info"
        >
          <Text style={[styles.title, { color: t.ink }]} numberOfLines={2}>
            {info.title}
          </Text>
          {info.when !== '' && (
            <Text style={[styles.when, { color: t.inkVariant }]}>{info.when}</Text>
          )}

          <View style={styles.stats}>
            <View style={styles.stat}>
              <Text style={[styles.statValue, { color: t.ink }]}>{info.distance}</Text>
              <Text style={[styles.statLabel, { color: t.inkMuted }]}>{info.distanceSub}</Text>
            </View>
            {info.elevation !== null && (
              <View style={[styles.stat, styles.statDivided, { borderColor: t.outlineVariant }]}>
                <Text style={[styles.statValue, { color: t.ink }]}>{info.elevation}</Text>
                <Text style={[styles.statLabel, { color: t.inkMuted }]}>Elevation</Text>
              </View>
            )}
            {info.climbed !== null && (
              <View style={[styles.stat, styles.statDivided, { borderColor: t.outlineVariant }]}>
                <Text style={[styles.statValue, { color: t.ink }]}>{info.climbed}</Text>
                <Text style={[styles.statLabel, { color: t.inkMuted }]}>Climbed so far</Text>
              </View>
            )}
          </View>

          {profile && profile.line !== '' && (
            <Svg width={profileW} height={PROFILE_H} accessibilityElementsHidden>
              <Path d={profile.area} fill={palette.ochre} opacity={0.18} />
              <Path d={profile.line} stroke={palette.ochre} strokeWidth={2} fill="none" />
              {cursorFrac !== null && (
                <>
                  <Line
                    x1={cursorFrac * profileW}
                    y1={0}
                    x2={cursorFrac * profileW}
                    y2={PROFILE_H}
                    stroke={t.ink}
                    strokeWidth={1.5}
                  />
                  <Circle
                    cx={cursorFrac * profileW}
                    cy={PROFILE_H / 2}
                    r={4}
                    fill={palette.ochre}
                    stroke={t.surface}
                    strokeWidth={1.5}
                  />
                </>
              )}
            </Svg>
          )}

          <View style={styles.provenance}>
            <Icon source="map-marker-outline" size={16} color={t.inkMuted} />
            <Text style={[styles.provenanceText, { color: t.inkMuted }]}>
              {photo.hidden ? `${info.provenance} · hidden from the map` : info.provenance}
            </Text>
          </View>
          {notice && (
            <Text style={[styles.notice, { color: t.inkVariant }]} testID="photo-notice">
              {notice}
            </Text>
          )}

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.strip}
          >
            {photos.map((p, i) => (
              <Pressable
                key={p.id}
                onPress={() => goTo(i)}
                accessibilityRole="button"
                accessibilityLabel={`Show photo ${i + 1}`}
                accessibilityState={{ selected: i === index }}
                style={[
                  styles.thumbWrap,
                  i === index && { borderColor: palette.sage },
                  i !== index && { borderColor: 'transparent' },
                ]}
              >
                <Image source={{ uri: photoFileUri(p.thumb) }} style={styles.thumb} />
              </Pressable>
            ))}
          </ScrollView>

          <View style={styles.actions}>
            <Button
              mode="contained-tonal"
              icon="map-marker-outline"
              onPress={showOnMap}
              accessibilityLabel="Show on map"
              style={styles.action}
              compact
            >
              Show on map
            </Button>
            <Button
              mode="outlined"
              icon="pencil-outline"
              disabled={!editable || busy}
              onPress={() => setCaptioning(photo.caption ?? '')}
              accessibilityLabel="Caption"
              style={styles.action}
              compact
            >
              Caption
            </Button>
            <Button
              mode="outlined"
              icon="share-variant"
              disabled={isNotePhoto(photo)}
              onPress={() => void share()}
              accessibilityLabel="Share photo"
              style={styles.action}
              compact
            >
              Share
            </Button>
          </View>
        </View>
      )}

      {/* User-initiated dialogs only (never on a launch or error path). */}
      <Portal>
        <Dialog visible={captioning !== null} onDismiss={() => setCaptioning(null)}>
          <Dialog.Title>Caption</Dialog.Title>
          <Dialog.Content>
            <TextInput
              mode="outlined"
              value={captioning ?? ''}
              onChangeText={setCaptioning}
              placeholder="What is in this photo?"
              autoFocus
              maxLength={200}
              returnKeyType="done"
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setCaptioning(null)}>Cancel</Button>
            <Button
              disabled={busy}
              onPress={() => {
                const caption = captioning ?? '';
                setCaptioning(null);
                if (photo) {
                  void run('save the caption', async () => {
                    await useTrailPhotosStore.getState().editPhoto(trackId, photo.id, { caption });
                  });
                }
              }}
            >
              Save
            </Button>
          </Dialog.Actions>
        </Dialog>
        <Dialog visible={confirmRemove} onDismiss={() => setConfirmRemove(false)}>
          <Dialog.Title>Remove photo</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {`Remove this photo from "${track?.name ?? 'the trail'}"? Inukshuk's copy is deleted. The photo in your phone's library is not touched.`}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmRemove(false)}>Cancel</Button>
            <Button
              textColor={palette.signalRed}
              onPress={() => {
                setConfirmRemove(false);
                if (photo) {
                  void run('remove the photo', async () => {
                    await useTrailPhotosStore.getState().removePhoto(trackId, photo.id);
                  });
                }
              }}
            >
              Remove
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Snackbar visible={message !== null} onDismiss={dismiss} duration={Number.POSITIVE_INFINITY}>
        {message ?? ''}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  counter: { color: palette.white, fontSize: 16, fontWeight: '800' },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 8,
  },
  title: { fontSize: 20, fontWeight: '800' },
  when: { fontSize: 13.5 },
  stats: { flexDirection: 'row', marginTop: 4 },
  stat: { flex: 1, gap: 1 },
  statDivided: { borderLeftWidth: StyleSheet.hairlineWidth, paddingLeft: 12 },
  statValue: { fontSize: 19, fontWeight: '800' },
  statLabel: { fontSize: 12 },
  provenance: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  provenanceText: { fontSize: 12.5, flex: 1 },
  notice: { fontSize: 12.5 },
  strip: { gap: 6, paddingVertical: 2 },
  thumbWrap: { borderWidth: 2, borderRadius: 8, overflow: 'hidden' },
  thumb: { width: THUMB, height: THUMB },
  actions: { flexDirection: 'row', gap: 8, marginTop: 2 },
  action: { flex: 1 },
});
