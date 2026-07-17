import { describeUploadOutcome } from '@core/strava/upload';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import { uploadTrackToStrava, type UploadableTrack } from '@lib/strava';
import { useLibraryStore } from '@state/libraryStore';
import { useRecorderStore } from '@state/recorderStore';
import { useStravaStore } from '@state/stravaStore';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Snackbar } from 'react-native-paper';

/** How long the "Push to Strava?" offer stays available. */
const PROMPT_MS = 10_000;

/**
 * Root-mounted, non-blocking "Push to Strava?" prompt. Observes the recorder
 * store's `lastSavedTrackId` (set when a recording is stopped AND saved) so
 * the recording flow itself needs no Strava code; the prompt only appears when
 * a Strava account is connected. Inline snackbars only — deliberately never a
 * Portal/Dialog on this spontaneous path — with self-managed timers (paper's
 * own snackbar timer doesn't fire on some Samsung/One UI devices).
 */
export function StravaPushPrompt() {
  const [prompt, setPrompt] = useState<UploadableTrack | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const { message: outcome, show: showOutcome, dismiss: dismissOutcome } = useTimedSnackbar(5000);

  // The prompt's own dismiss timer lives in a ref: the effect below re-runs
  // when it consumes lastSavedTrackId, and must not clear the timer then.
  const promptTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const closePrompt = useCallback(() => {
    if (promptTimer.current) clearTimeout(promptTimer.current);
    promptTimer.current = undefined;
    setPrompt(null);
  }, []);

  // Observe the recorder store directly (an external system): the stop path
  // sets lastSavedTrackId, we consume it one-shot and offer the push.
  useEffect(() => {
    const unsubscribe = useRecorderStore.subscribe((state, prev) => {
      const savedId = state.lastSavedTrackId;
      if (savedId === null || savedId === prev.lastSavedTrackId) return;
      // Consume one-shot: whatever happens next, this save prompts only once.
      state.acknowledgeSavedTrack();
      if (useStravaStore.getState().connection === null) return;
      const track = useLibraryStore.getState().tracks.find((t) => t.id === savedId);
      if (!track) return;
      if (promptTimer.current) clearTimeout(promptTimer.current);
      setPrompt({ id: track.id, name: track.name, fileUri: track.fileUri });
      promptTimer.current = setTimeout(() => setPrompt(null), PROMPT_MS);
    });
    return () => {
      unsubscribe();
      if (promptTimer.current) clearTimeout(promptTimer.current);
    };
  }, []);

  const onPush = useCallback(() => {
    const track = prompt;
    if (!track) return;
    closePrompt();
    setUploading(track.name);
    void uploadTrackToStrava(track)
      .then((result) => showOutcome(describeUploadOutcome(result, track.name)))
      .finally(() => setUploading(null));
  }, [prompt, closePrompt, showOutcome]);

  return (
    <>
      <Snackbar
        visible={prompt !== null}
        onDismiss={closePrompt}
        duration={Number.POSITIVE_INFINITY}
        action={{ label: 'Push', onPress: onPush }}
      >
        {prompt ? `Push "${prompt.name}" to Strava?` : ''}
      </Snackbar>
      <Snackbar
        visible={uploading !== null}
        onDismiss={() => undefined}
        duration={Number.POSITIVE_INFINITY}
      >
        {uploading ? `Uploading "${uploading}" to Strava…` : ''}
      </Snackbar>
      <Snackbar
        visible={outcome !== null}
        onDismiss={dismissOutcome}
        duration={Number.POSITIVE_INFINITY}
      >
        {outcome ?? ''}
      </Snackbar>
    </>
  );
}
