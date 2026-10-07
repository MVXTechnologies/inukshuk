import type { TrackSummary } from '@core/models';
import { isNotePhoto, type TrackPhoto } from '@core/photos/model';
import { visiblePhotos } from '@core/photos/stack';
import { photoCountLabel } from '@core/photos/summary';
import { writeTrailPhotoZip } from '@data/photos/zipExport';
import { deleteFileAt, resolveDocumentPath } from '@data/storage';
import { reportError } from '@lib/errorReporting';
import { useSettingsStore } from '@state/settingsStore';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Icon, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Share a trail (#587, owner Q8): the GPX alone, or "Trail + photos" as a zip
 * (the GPX with a waypoint per photo, plus the photos with no location data
 * inside the files). The highlighted choice follows Settings → Photos →
 * "Include photos when sharing a trail" (off by default). Opened only for a
 * trail that has photos of its own; a plain themed sheet, never a Portal.
 */
export interface ShareTrailSheetProps {
  visible: boolean;
  track: TrackSummary;
  /** The trail's own photos (note photos are never shared in the zip). */
  photos: readonly TrackPhoto[];
  onClose: () => void;
  /** A one-line message for the screen's snackbar. */
  onMessage: (message: string) => void;
}

export function ShareTrailSheet(props: ShareTrailSheetProps) {
  if (!props.visible) return null;
  return <SheetContent {...props} />;
}

type Busy = null | 'gpx' | 'zip';

function SheetContent({ track, photos, onClose, onMessage }: ShareTrailSheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const withPhotosByDefault = useSettingsStore((s) => s.includePhotosWhenSharing);
  const [busy, setBusy] = useState<Busy>(null);
  const shared = visiblePhotos(photos).filter((p) => !isNotePhoto(p));

  // Android's Back closes the sheet (not the trail view behind it).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!busy) onClose();
      return true;
    });
    return () => sub.remove();
  }, [busy, onClose]);

  const run = async (kind: Exclude<Busy, null>) => {
    if (busy) return;
    if (!(await Sharing.isAvailableAsync())) {
      onMessage('Sharing is not available on this device');
      return;
    }
    setBusy(kind);
    let zipUri: string | null = null;
    try {
      if (kind === 'gpx') {
        await Sharing.shareAsync(resolveDocumentPath(track.fileUri), {
          mimeType: 'application/gpx+xml',
          UTI: 'public.xml',
        });
      } else {
        const zip = await writeTrailPhotoZip({
          trackName: track.name,
          gpxUri: track.fileUri,
          photos: shared,
        });
        zipUri = zip.uri;
        await Sharing.shareAsync(zip.uri, {
          mimeType: 'application/zip',
          UTI: 'public.zip-archive',
          dialogTitle: track.name,
        });
        if (zip.skipped > 0) {
          onMessage(
            `${photoCountLabel(zip.skipped)} could not be checked and ${zip.skipped === 1 ? 'was' : 'were'} left out`,
          );
        }
      }
      onClose();
    } catch (err) {
      reportError(err, `share-trail-${kind}`);
      onMessage(kind === 'zip' ? 'Could not prepare the photos' : 'Could not share the trail');
    } finally {
      if (zipUri) {
        try {
          deleteFileAt(zipUri);
        } catch {
          // The cache: the OS reclaims it.
        }
      }
      setBusy(null);
    }
  };

  const options: {
    kind: Exclude<Busy, null>;
    icon: string;
    title: string;
    hint: string;
    preferred: boolean;
  }[] = [
    {
      kind: 'gpx',
      icon: 'map-marker-path',
      title: 'GPX file only',
      hint: 'The trail, its waypoints and notes',
      preferred: !withPhotosByDefault,
    },
    {
      kind: 'zip',
      icon: 'folder-zip-outline',
      title: 'Trail + photos (zip)',
      hint:
        busy === 'zip'
          ? `Preparing ${photoCountLabel(shared.length)}…`
          : `The GPX and ${photoCountLabel(shared.length)}`,
      preferred: withPhotosByDefault,
    },
  ];

  return (
    <View style={styles.scrim} testID="share-trail-sheet">
      <Pressable
        style={styles.backdrop}
        onPress={busy ? undefined : onClose}
        accessibilityLabel="Close sharing"
      />
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.elevation.level2,
            paddingBottom: insets.bottom + 16,
            shadowColor: theme.colors.shadow,
          },
        ]}
      >
        <View style={[styles.handle, { backgroundColor: theme.colors.outlineVariant }]} />
        <Text variant="titleMedium" style={styles.title}>
          Share “{track.name}”
        </Text>
        {options.map((o) => (
          <Pressable
            key={o.kind}
            onPress={() => void run(o.kind)}
            disabled={busy !== null}
            accessibilityRole="button"
            accessibilityLabel={o.title}
            accessibilityState={{ disabled: busy !== null, selected: o.preferred }}
            style={({ pressed }) => [
              styles.row,
              {
                borderColor: o.preferred ? theme.colors.secondary : theme.colors.outlineVariant,
                backgroundColor: o.preferred ? theme.colors.secondaryContainer : 'transparent',
                opacity: pressed ? 0.7 : busy !== null && busy !== o.kind ? 0.5 : 1,
              },
            ]}
          >
            <Icon
              source={o.icon}
              size={24}
              color={o.preferred ? theme.colors.onSecondaryContainer : theme.colors.onSurface}
            />
            <View style={styles.rowText}>
              <Text
                variant="titleSmall"
                style={{
                  color: o.preferred ? theme.colors.onSecondaryContainer : theme.colors.onSurface,
                }}
              >
                {o.title}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {o.hint}
              </Text>
            </View>
            {busy === o.kind ? (
              <ActivityIndicator size={20} />
            ) : (
              <Icon source="chevron-right" size={22} color={theme.colors.onSurfaceVariant} />
            )}
          </Pressable>
        ))}
        <View style={styles.privacy}>
          <Icon source="shield-lock-outline" size={18} color={theme.colors.onSurfaceVariant} />
          <Text
            variant="bodySmall"
            style={[styles.privacyText, { color: theme.colors.onSurfaceVariant }]}
          >
            Photos are shared without location data inside the files; their places are waypoints in
            the GPX.
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  card: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 10,
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 },
    elevation: 12,
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 6 },
  title: { fontWeight: '800', marginBottom: 2, paddingHorizontal: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 64,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    borderWidth: 1,
  },
  rowText: { flex: 1, gap: 2 },
  privacy: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingHorizontal: 4 },
  privacyText: { flex: 1 },
});
