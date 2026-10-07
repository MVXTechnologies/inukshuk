import { formatClockTime } from '@core/format';
import { captureToastText, type PendingPhoto } from '@core/photos/capture';
import { deleteCapturedPhoto, writeCapturedCopies } from '@data/photos/capturedPhotos';
import * as storage from '@data/storage';
import { reportError } from '@lib/errorReporting';
import { formatDistance, formatElevation } from '@state/formatters';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { useTimedSnackbar } from '../common/useTimedSnackbar';
import { photoResizer } from './photoResizer';

/** How long the "Photo 7 added" card (with Undo) stays up. */
const TOAST_MS = 6000;

export interface CaptureToast {
  photoId: string;
  thumbUri: string;
  title: string;
  detail: string;
}

export interface RecordingPhoto {
  /** Open the camera; the shot joins the recording. */
  capture: () => void;
  /** A capture is being copied (the button shows it). */
  busy: boolean;
  /** The "Photo N added" card, or null. */
  toast: CaptureToast | null;
  undo: () => void;
  dismiss: () => void;
}

/**
 * The recording panel's Photo button (#587, DESIGN §4.1): camera → copies in
 * the session's photo folder (through the shared resizer, location removed)
 * → a checkpointed pending photo → a card with Undo. The position is the
 * recorder's latest fix (iOS camera shots carry no GPS anyway).
 *
 * Android may kill the activity while the camera is up; the result then comes
 * back through `getPendingResultAsync()` when the app resumes (or relaunches
 * into the recovered session), and is handled the same way.
 *
 * `onMessage` reports failures in the screen's own snackbar.
 */
export function useRecordingPhoto(onMessage: (message: string) => void): RecordingPhoto {
  const [busy, setBusy] = useState(false);
  const { message: toastId, show: showToast, dismiss: dismissToast } = useTimedSnackbar(TOAST_MS);
  const [toastPhoto, setToastPhoto] = useState<{ photo: PendingPhoto; n: number } | null>(null);
  const cameraOpen = useRef(false);
  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onMessageRef.current = onMessage;
  });

  const handleShot = useCallback(
    async (asset: ImagePicker.ImagePickerAsset) => {
      const store = useRecorderStore.getState();
      const last = store.points[store.points.length - 1];
      const session = store.photoSessionFor();
      if (!last || session === null) {
        onMessageRef.current('Waiting for a GPS fix before adding a photo');
        quietDelete(asset.uri);
        return;
      }
      setBusy(true);
      const id = storage.newId();
      try {
        const resized = await photoResizer.resize(asset.uri);
        const fullSize = useSettingsStore.getState().photoCopySize === 'full';
        const copies = await writeCapturedCopies(session, id, asset.uri, resized, fullSize);
        const pending: PendingPhoto = {
          id,
          takenAt: Date.now(),
          lngLat: [last.longitude, last.latitude],
          distanceM: useRecorderStore.getState().stats.distanceM,
          file: copies.paths.file,
          thumb: copies.paths.thumb,
          sprite: copies.paths.sprite,
          width: fullSize ? resized.sourceWidth : resized.display.width,
          height: fullSize ? resized.sourceHeight : resized.display.height,
          bytes: copies.bytes,
        };
        if (typeof last.altitude === 'number') pending.elevationM = last.altitude;
        if (copies.contentHash) pending.contentHash = copies.contentHash;
        let n: number;
        try {
          n = useRecorderStore.getState().addPhoto(pending);
        } catch (err) {
          deleteCapturedPhoto(copies.paths);
          throw err;
        }
        setToastPhoto({ photo: pending, n });
        showToast(id);
      } catch (err) {
        reportError(err, 'recording-photo');
        onMessageRef.current(
          err instanceof Error && /storage/i.test(err.message)
            ? err.message
            : 'Could not add the photo to this recording',
        );
      } finally {
        // The camera's own file (with its EXIF) never outlives the copy.
        quietDelete(asset.uri);
        setBusy(false);
      }
    },
    [showToast],
  );

  const handleResult = useCallback(
    (result: ImagePicker.ImagePickerResult | ImagePicker.ImagePickerErrorResult | null) => {
      if (!result || !('assets' in result) || result.canceled) return;
      const asset = result.assets?.[0];
      if (asset) void handleShot(asset);
    },
    [handleShot],
  );

  const capture = useCallback(() => {
    void (async () => {
      try {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          onMessageRef.current('Camera permission denied');
          return;
        }
        cameraOpen.current = true;
        const result = await ImagePicker.launchCameraAsync({ quality: 0.92, exif: true });
        cameraOpen.current = false;
        handleResult(result);
      } catch (err) {
        cameraOpen.current = false;
        reportError(err, 'recording-camera');
        onMessageRef.current('Could not open the camera');
      }
    })();
  }, [handleResult]);

  // Android: a shot taken while the OS recreated the activity.
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const recover = () => {
      if (useRecorderStore.getState().status === 'idle') return;
      ImagePicker.getPendingResultAsync()
        .then(handleResult)
        .catch(() => undefined);
    };
    recover();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && cameraOpen.current) recover();
    });
    return () => sub.remove();
  }, [handleResult]);

  const undo = useCallback(() => {
    const id = toastId;
    dismissToast();
    if (id) useRecorderStore.getState().removePhoto(id);
  }, [toastId, dismissToast]);

  const shown = toastPhoto && toastPhoto.photo.id === toastId ? toastPhoto : null;
  const toast: CaptureToast | null = shown
    ? {
        photoId: shown.photo.id,
        thumbUri: storage.resolveDocumentPath(shown.photo.thumb),
        ...captureToastText(shown.n, [
          formatDistance(shown.photo.distanceM),
          shown.photo.elevationM === undefined ? null : formatElevation(shown.photo.elevationM),
          formatClockTime(shown.photo.takenAt),
        ]),
      }
    : null;

  return { capture, busy, toast, undo, dismiss: dismissToast };
}

function quietDelete(uri: string): void {
  try {
    storage.deleteFileAt(uri);
  } catch {
    // The picker's cache; the OS reclaims it.
  }
}
