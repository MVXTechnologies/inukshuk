import {
  analyzeRecordingHealth,
  describeRecordingHealth,
  isFixableByUser,
  type RecordingHealth,
  type TimeInterval,
} from '@core/geo/track/recordingHealth';
import type { TrackPoint } from '@core/models';
import { isApproximateLocation } from '@lib/recordingReadiness';
import { useRecorderStore } from '@state/recorderStore';
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

/** After returning to the foreground, wait this long for fresh fixes (and the
 * journal merge) so the gap's closing point exists before judging it. */
export const FOREGROUND_REVIEW_DELAY_MS = 15_000;

/** Session facts captured before `stop()` resets the recorder. */
export interface RecordingDiagnostics {
  startedAt: number;
  pauses: TimeInterval[];
  backgroundIntervals: TimeInterval[];
  approximateFixes: number;
  preciseLocation: boolean | null;
}

export interface RecordingHealthControls {
  /** Snapshot this session's diagnostics; call right before `stop()`. */
  capture: () => RecordingDiagnostics | null;
  /** Judge a stopped recording; reports a fixable problem via `onIssue`. */
  reviewStopped: (diag: RecordingDiagnostics, points: readonly TrackPoint[]) => RecordingHealth;
}

function closedIntervals(open: number | null, closed: TimeInterval[], now: number): TimeInterval[] {
  return open === null ? closed : [...closed, { from: open, to: now }];
}

/**
 * Watches a live recording for the two failures users can fix in their phone's
 * settings — approximate location and GPS that stops with the screen off —
 * and calls `onIssue` with a one-line explanation (see
 * `@core/geo/track/recordingHealth`). The record-start gate
 * (`useRecordingCheck`) already stops an approximate-location start, so the
 * precision read at start only feeds the analysis. It reports:
 *
 * - shortly after the app returns to the foreground mid-recording, when the
 *   screen-off spell left a gap (so the rest of the hike can still be saved);
 * - after Stop, for the whole recording.
 *
 * At most one live report per recording; the post-stop review always runs.
 */
export function useRecordingHealth({
  onIssue,
}: {
  onIssue: (message: string) => void;
}): RecordingHealthControls {
  const status = useRecorderStore((s) => s.status);
  const startedAt = useRecorderStore((s) => s.startedAt);

  const sessionRef = useRef<number | null>(null);
  const backgroundRef = useRef<TimeInterval[]>([]);
  const backgroundSinceRef = useRef<number | null>(null);
  const preciseRef = useRef<boolean | null>(null);
  const reportedRef = useRef(false);
  const onIssueRef = useRef(onIssue);
  useEffect(() => {
    onIssueRef.current = onIssue;
  }, [onIssue]);

  // New session → fresh diagnostics, and the precision at record start.
  useEffect(() => {
    if (startedAt === null || sessionRef.current === startedAt) return;
    sessionRef.current = startedAt;
    backgroundRef.current = [];
    backgroundSinceRef.current = AppState.currentState === 'active' ? null : Date.now();
    preciseRef.current = null;
    reportedRef.current = false;
    let cancelled = false;
    void isApproximateLocation().then((approximate) => {
      if (cancelled || sessionRef.current !== startedAt) return;
      preciseRef.current = approximate === null ? null : !approximate;
    });
    return () => {
      cancelled = true;
    };
  }, [startedAt]);

  const live = status !== 'idle';

  // Screen-off spells, and the mid-recording review after each one.
  useEffect(() => {
    if (!live) return;
    let reviewTimer: ReturnType<typeof setTimeout> | undefined;
    const sub = AppState.addEventListener('change', (state) => {
      const now = Date.now();
      if (state !== 'active') {
        if (backgroundSinceRef.current === null) backgroundSinceRef.current = now;
        return;
      }
      if (backgroundSinceRef.current !== null) {
        backgroundRef.current = [
          ...backgroundRef.current,
          { from: backgroundSinceRef.current, to: now },
        ];
        backgroundSinceRef.current = null;
      }
      if (reviewTimer) clearTimeout(reviewTimer);
      reviewTimer = setTimeout(() => {
        if (reportedRef.current) return;
        const s = useRecorderStore.getState();
        if (s.status === 'idle') return;
        const health = analyzeRecordingHealth({
          points: s.points,
          pauses: closedIntervals(s.pausedAt, s.pauses, Date.now()),
          backgroundIntervals: backgroundRef.current,
          approximateFixes: s.approximateFixes,
          preciseLocation: preciseRef.current,
        });
        if (!isFixableByUser(health.kind)) return;
        const message = describeRecordingHealth(health);
        if (!message) return;
        reportedRef.current = true;
        onIssueRef.current(message);
      }, FOREGROUND_REVIEW_DELAY_MS);
    });
    return () => {
      sub.remove();
      if (reviewTimer) clearTimeout(reviewTimer);
    };
  }, [live]);

  const capture = useCallback((): RecordingDiagnostics | null => {
    const s = useRecorderStore.getState();
    if (s.status === 'idle' || s.startedAt === null) return null;
    const now = Date.now();
    return {
      startedAt: s.startedAt,
      pauses: closedIntervals(s.pausedAt, s.pauses, now),
      backgroundIntervals: closedIntervals(backgroundSinceRef.current, backgroundRef.current, now),
      approximateFixes: s.approximateFixes,
      preciseLocation: preciseRef.current,
    };
  }, []);

  const reviewStopped = useCallback(
    (diag: RecordingDiagnostics, points: readonly TrackPoint[]): RecordingHealth => {
      const health = analyzeRecordingHealth({ ...diag, points });
      const message = describeRecordingHealth(health);
      if (message && isFixableByUser(health.kind)) onIssueRef.current(message);
      return health;
    },
    [],
  );

  return { capture, reviewStopped };
}
