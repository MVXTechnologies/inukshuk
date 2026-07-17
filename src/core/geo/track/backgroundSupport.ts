/**
 * Which app binaries can run the background-location recording task at all.
 *
 * The vc44 (app version 1.0.2) binary shipped without
 * `RECEIVE_BOOT_COMPLETED` in its Android manifest. expo-task-manager
 * schedules its location jobs with `.setPersisted(true)` unconditionally, and
 * Android rejects persisted jobs without that permission by THROWING inside
 * `TaskBroadcastReceiver.onReceive` — a native, uncatchable process death.
 * Any GPS fix delivered while the app is backgrounded (screen off, or parked
 * behind the "Allow all the time" system screen) kills the app; because the
 * task registration itself persists natively, every relaunch restarts the
 * service and the next fix kills the app again — a crash loop only broken by
 * clearing app data or stopping the task from JS before a fix arrives.
 *
 * Binaries from 1.0.3 (vc45) declare the permission. This gate keeps the
 * OTA-updated JS from ever starting the task on a binary that cannot survive
 * it: on unsupported runtimes recording falls back to the foreground watch
 * (screen must stay on), which is degraded but correct.
 */

/** First runtime whose binary declares RECEIVE_BOOT_COMPLETED. */
const FIRST_SUPPORTED = [1, 0, 3] as const;

function parseVersion(v: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * True when the given runtime version's binary can run the background
 * recording task without crashing. Unparseable/unknown versions return true —
 * future runtimes must not silently lose the feature; the known-broken
 * versions are exactly the pre-1.0.3 ones.
 */
export function backgroundTaskSupported(runtimeVersion: string | null | undefined): boolean {
  if (runtimeVersion == null) return true;
  const parsed = parseVersion(runtimeVersion);
  if (parsed === null) return true;
  for (let i = 0; i < 3; i++) {
    const have = parsed[i] ?? 0;
    const need = FIRST_SUPPORTED[i] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
}
