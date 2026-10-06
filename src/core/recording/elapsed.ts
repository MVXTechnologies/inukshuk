/**
 * The recording HUD's elapsed (active) time: wall time since the start, minus
 * every completed pause (`pausedMs`). While paused it is frozen at the pause
 * start (`pausedAt`), so a recording recovered paused after a crash shows the
 * time it had, not 0:00 until Resume is tapped (#325).
 */
export function recordingElapsedS(args: {
  startedAt: number;
  pausedMs: number;
  /** The in-flight pause's start, while paused; null while recording. */
  pausedAt: number | null;
  now: number;
}): number {
  const until = args.pausedAt ?? args.now;
  return Math.max(0, Math.floor((until - args.startedAt - args.pausedMs) / 1000));
}
