import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import { useStravaStore } from '@state/stravaStore';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Snackbar } from 'react-native-paper';

/** How long the offer stays up. */
export const PHOTO_PROMPT_MS = 10_000;
/** With Strava connected, its "Push to Strava?" goes first; this waits its turn. */
export const AFTER_STRAVA_DELAY_MS = PHOTO_PROMPT_MS + 500;

/**
 * "Add photos from this outing?" (#587, owner Q6 B): offered once, right after
 * a recording is saved, opening the trail with the Add-photos sheet. Like
 * `StravaPushPrompt`, it observes the recorder's `lastSavedTrackId` (the
 * recording flow knows nothing of it) and is an inline snackbar with its own
 * timers — never a Portal/Dialog on this spontaneous path. It does not
 * consume `lastSavedTrackId` (the Strava prompt does); it only reads the
 * change.
 */
export function AddPhotosAfterSavePrompt() {
  const router = useRouter();
  const [trackId, setTrackId] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  };

  const close = useCallback(() => {
    clearTimers();
    setTrackId(null);
  }, []);

  useEffect(() => {
    const unsubscribe = useRecorderStore.subscribe((state, prev) => {
      const savedId = state.lastSavedTrackId;
      if (savedId === null || savedId === prev.lastSavedTrackId) return;
      const settings = useSettingsStore.getState();
      if (settings.photoPromptAfterSaveShown) return;
      // Asked once: whatever the answer, it is not asked again.
      settings.set('photoPromptAfterSaveShown', true);
      clearTimers();
      const delay = useStravaStore.getState().connection === null ? 0 : AFTER_STRAVA_DELAY_MS;
      timers.current.push(
        setTimeout(() => {
          setTrackId(savedId);
          timers.current.push(setTimeout(() => setTrackId(null), PHOTO_PROMPT_MS));
        }, delay),
      );
    });
    return () => {
      unsubscribe();
      clearTimers();
    };
  }, []);

  const onAdd = useCallback(() => {
    const id = trackId;
    close();
    if (id) router.push(`/trail3d/${id}?addPhotos=1` as never);
  }, [trackId, close, router]);

  return (
    <Snackbar
      visible={trackId !== null}
      onDismiss={close}
      duration={Number.POSITIVE_INFINITY}
      action={{ label: 'Add photos', onPress: onAdd }}
    >
      Add photos from this outing?
    </Snackbar>
  );
}
