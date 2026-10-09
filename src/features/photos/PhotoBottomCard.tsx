/**
 * A tapped photo as a bottom card (owner 2026-10-07: "not another page"; and
 * later the same day, of the full-screen viewer: "I hate that view. forget
 * it."). Everything is here: the photo, its caption, when and where on the
 * trail, the team's comments with the reply box (+task, resolve), and for my
 * own photos Caption / Share / Hide / Remove. The map stays visible above.
 * The comments scroll inside the card; swipe the card's head down to close
 * (a swipe up does nothing). Above the keyboard while typing, on both platforms.
 * A plain themed View (paper-surface-ios-flex-collapse).
 */
import type { TrackPhoto } from '@core/photos/model';
import { isNotePhoto } from '@core/photos/model';
import { photoEditFailureMessage } from '@core/photos/status';
import { PhotoTeamComments } from '@features/team/PhotoTeamComments';
import { useLibraryStore } from '@state/libraryStore';
import { useTeamStore } from '@state/teamStore';
import { photosEditable, useTrailPhotosStore } from '@state/trailPhotosStore';
import { KeyboardLifted, useKeyboardHeight } from '@ui/components/KeyboardLifted';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import * as Sharing from 'expo-sharing';
import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Icon, IconButton, Text, TextInput } from 'react-native-paper';
import { create } from 'zustand';

import { formatPhotoWhen } from './photoText';
import { photoFileUri } from './photoUri';
import { shareablePhotoUri, UnshareablePhotoError, type ShareablePhoto } from './sharePhoto';

export type PhotoCardTarget =
  | { kind: 'own'; trackId: string; photoId: string }
  | { kind: 'team'; owner: string; trackId: string; photoId: string };

export const usePhotoCard = create<{
  target: PhotoCardTarget | null;
  show: (t: PhotoCardTarget) => void;
  close: () => void;
}>((set) => ({
  target: null,
  show: (target) => set({ target }),
  close: () => set({ target: null }),
}));

const SWIPE = 40;

/**
 * `dockStyle` places the card (absolute, bottom-docked). It is the view that
 * rises above the keyboard, so it must not sit in a wrapper sized to the card:
 * Android leaves a view moved outside its parents' bounds out of the
 * accessibility tree (E2E run 37814960809).
 */
export function PhotoBottomCard({ dockStyle }: { dockStyle?: StyleProp<ViewStyle> }) {
  const t = useSchemeTokens();
  const { height: windowH } = useWindowDimensions();
  const target = usePhotoCard((s) => s.target);
  const close = usePhotoCard((s) => s.close);
  const own = useTrailPhotosStore((s) =>
    target?.kind === 'own'
      ? s.byTrack[target.trackId]?.photos.find((p) => p.id === target.photoId)
      : undefined,
  );
  const ownStatus = useTrailPhotosStore((s) =>
    target?.kind === 'own' ? s.byTrack[target.trackId]?.status : undefined,
  );
  const teamPhoto = useTeamStore((s) =>
    target ? s.photos.find((p) => p.id === target.photoId) : undefined,
  );
  const threads = useTeamStore((s) => s.photoThreads);

  // Above the keyboard on both platforms (KeyboardLifted); shorter while it
  // is up, the comments scrolling inside.
  const keyboard = useKeyboardHeight();
  const scrollRef = useRef<ScrollView>(null);

  // Swipe the head down to close. Up does nothing; the comments scroll.
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderRelease: (_e, g) => {
          if (g.dy > SWIPE) usePhotoCard.getState().close();
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
  const sub = [
    photo.takenAt ? formatPhotoWhen(photo.takenAt) : null,
    photo.km !== null ? `km ${photo.km.toFixed(1)}` : null,
    said.length > 0 ? `${said.length} comment${said.length === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <KeyboardLifted style={dockStyle}>
      <View
        style={[
          styles.card,
          {
            backgroundColor: t.elevation.level2,
            shadowColor: palette.shadow,
            maxHeight: Math.max(240, (windowH - keyboard) * 0.62),
          },
        ]}
        testID="photo-card"
      >
        <View {...pan.panHandlers} style={styles.head}>
          <View style={[styles.grabber, { backgroundColor: t.outlineVariant }]} />
          <View style={styles.row}>
            {photo.uri ? (
              <Image
                source={{ uri: photo.uri }}
                style={styles.thumb}
                accessibilityIgnoresInvertColors
                testID="photo-card-image"
              />
            ) : (
              <View style={[styles.thumb, { backgroundColor: t.surfaceVariant }]} />
            )}
            <View style={styles.flex}>
              <Text variant="titleSmall" style={{ color: t.ink }} numberOfLines={2}>
                {photo.caption ?? 'Photo'}
              </Text>
              {sub ? (
                <Text variant="bodySmall" style={{ color: t.inkVariant }} numberOfLines={2}>
                  {sub}
                </Text>
              ) : null}
            </View>
            <IconButton
              icon="close"
              size={20}
              onPress={close}
              accessibilityLabel="Close"
              testID="photo-card-close"
            />
          </View>
        </View>
        {target.kind === 'own' && own && (
          <OwnPhotoActions
            trackId={target.trackId}
            photo={own}
            editable={photosEditable(ownStatus) && !isNotePhoto(own)}
          />
        )}
        <ScrollView
          ref={scrollRef}
          // Newest last, like a chat: the latest comment and the reply box
          // stay in view as comments arrive (and above the keyboard).
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          style={styles.scroll}
          contentContainerStyle={styles.scrollBody}
          keyboardShouldPersistTaps="handled"
          testID="photo-card-scroll"
        >
          <PhotoTeamComments photoId={target.photoId} all />
        </ScrollView>
      </View>
    </KeyboardLifted>
  );
}

/** My own photo: Caption (inline), Share, Hide from the map, Remove. */
function OwnPhotoActions({
  trackId,
  photo,
  editable,
}: {
  trackId: string;
  photo: TrackPhoto;
  editable: boolean;
}) {
  const t = useSchemeTokens();
  const trackName = useLibraryStore((s) => s.tracks.find((x) => x.id === trackId)?.name);
  const [captioning, setCaptioning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (label: string, job: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await job();
    } catch (err) {
      setError(photoEditFailureMessage(err, `Could not ${label}`));
    } finally {
      setBusy(false);
    }
  };
  const saveCaption = () => {
    const caption = captioning ?? '';
    setCaptioning(null);
    void run('save the caption', () =>
      useTrailPhotosStore.getState().editPhoto(trackId, photo.id, { caption }),
    );
  };
  const share = async () => {
    if (!(await Sharing.isAvailableAsync())) {
      setError('Sharing is not available on this device');
      return;
    }
    // The kept copy carries no location; it is checked again before it leaves.
    let shareable: ShareablePhoto | null = null;
    try {
      shareable = await shareablePhotoUri(photo);
      await Sharing.shareAsync(shareable.uri, { mimeType: 'image/jpeg', UTI: 'public.jpeg' });
    } catch (err) {
      setError(err instanceof UnshareablePhotoError ? err.message : 'Could not share the photo');
    } finally {
      shareable?.dispose();
    }
  };
  const remove = () =>
    Alert.alert(
      'Remove photo',
      `Remove this photo from "${trackName ?? 'the trail'}"? Inukshuk's copy is deleted. The photo in your phone's library is not touched.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            usePhotoCard.getState().close();
            void run('remove the photo', () =>
              useTrailPhotosStore.getState().removePhoto(trackId, photo.id),
            );
          },
        },
      ],
    );

  if (captioning !== null)
    return (
      <View style={styles.captionRow}>
        <TextInput
          mode="outlined"
          dense
          style={styles.flex}
          value={captioning}
          onChangeText={setCaptioning}
          placeholder="What is in this photo?"
          autoFocus
          maxLength={200}
          returnKeyType="done"
          onSubmitEditing={saveCaption}
          testID="photo-card-caption-input"
        />
        <IconButton
          icon="check"
          mode="contained"
          onPress={saveCaption}
          accessibilityLabel="Save"
          testID="photo-card-caption-save"
        />
        <IconButton icon="close" onPress={() => setCaptioning(null)} accessibilityLabel="Cancel" />
      </View>
    );
  const action = (
    icon: string,
    label: string,
    onPress: () => void,
    testID: string,
    enabled = true,
  ) => (
    <Pressable
      key={testID}
      onPress={enabled && !busy ? onPress : undefined}
      disabled={!enabled || busy}
      style={[styles.action, { borderColor: t.outlineVariant, opacity: enabled ? 1 : 0.4 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled || busy }}
      testID={testID}
    >
      <Icon source={icon} size={18} color={t.ink} />
      <Text variant="labelMedium" style={{ color: t.ink }}>
        {label}
      </Text>
    </Pressable>
  );
  return (
    <View style={styles.actionsWrap}>
      <View style={styles.actions}>
        {action(
          'pencil-outline',
          'Caption',
          () => setCaptioning(photo.caption ?? ''),
          'photo-card-caption',
          editable,
        )}
        {action('share-variant', 'Share', () => void share(), 'photo-card-share')}
        {action(
          photo.hidden ? 'eye-outline' : 'eye-off-outline',
          photo.hidden ? 'Show' : 'Hide',
          () =>
            void run(photo.hidden ? 'show the photo' : 'hide the photo', () =>
              useTrailPhotosStore
                .getState()
                .editPhoto(trackId, photo.id, { hidden: !photo.hidden }),
            ),
          'photo-card-hide',
          editable,
        )}
        {action('trash-can-outline', 'Remove', remove, 'photo-card-remove', editable)}
      </View>
      {error !== null && (
        <Text variant="bodySmall" style={{ color: t.status.gpsLostInk }}>
          {error}
        </Text>
      )}
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
  head: { gap: 8 },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  thumb: { width: 112, height: 84, borderRadius: 12 },
  actionsWrap: { gap: 4 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  captionRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  // Shrinks within the card's max height (a keyboard halves it), so the reply box
  // stays in the card instead of overflowing past its clipped bottom (Android).
  scroll: { flexGrow: 0, flexShrink: 1 },
  scrollBody: { paddingBottom: 4 },
});
