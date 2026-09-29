import { shouldAutoImport } from '@core/import/auto';
import { resolveRange } from '@core/import/plan';
import { canImport } from '@core/strava/tokens';
import { isNetworkAllowed } from '@data/storage';
import { useImportStore } from '@state/importStore';
import { useLibraryStore } from '@state/libraryStore';
import { useStravaStore } from '@state/stravaStore';
import { AppState } from 'react-native';

import { isImportRunning, startSourceImport } from './importController';

/**
 * Strava auto-import (#432): on app start (once everything has loaded) and
 * every return to the foreground, quietly import what is new since the last
 * import — at most once per 15 minutes. The rules are pure
 * (`@core/import/auto`); this wires them to the stores and AppState.
 */

let lastAttemptAt: number | null = null;

/** Check the rules now and start a quiet import if they allow it. Returns whether it started. */
export function maybeAutoImportStrava(now: number = Date.now()): boolean {
  const imports = useImportStore.getState();
  const strava = useStravaStore.getState();
  const library = useLibraryStore.getState();
  const go = shouldAutoImport({
    enabled: imports.autoImportStrava,
    canImport: canImport(strava.connection),
    networkAllowed: isNetworkAllowed(),
    hydrated: imports.hydrated && strava.hydrated && library.hydrated,
    hasJob: imports.job !== null || isImportRunning(),
    lastImportAt: imports.lastImportAt.strava ?? null,
    lastAttemptAt,
    now,
  });
  if (!go) return false;
  lastAttemptAt = now;
  void startSourceImport({
    source: 'strava',
    range: resolveRange('since-last', imports.lastImportAt.strava ?? null),
    quiet: true,
  });
  return true;
}

/**
 * Start watching: checks when the stores finish loading and whenever the app
 * becomes active. Returns the unsubscribe.
 */
export function installStravaAutoImport(): () => void {
  const check = () => {
    maybeAutoImportStrava();
  };
  const unsubs = [
    useImportStore.subscribe((s, prev) => {
      if (s.hydrated && !prev.hydrated) check();
    }),
    useStravaStore.subscribe((s, prev) => {
      if (s.hydrated && !prev.hydrated) check();
    }),
    useLibraryStore.subscribe((s, prev) => {
      if (s.hydrated && !prev.hydrated) check();
    }),
  ];
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') check();
  });
  check();
  return () => {
    for (const u of unsubs) u();
    appState.remove();
  };
}

/** Test seam. */
export function resetAutoImportForTests(): void {
  lastAttemptAt = null;
}
