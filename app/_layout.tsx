// This import is FIRST deliberately: loading @lib/backgroundLocation
// registers the background-location task (TaskManager.defineTask) at module
// scope, so a headless launch — Android killing and relaunching the app
// mid-recording — re-registers the handler before any UI mounts.
import { cleanupBackgroundLocationAtLaunch } from '@lib/backgroundLocation';

import { ErrorBoundary } from '@features/common/components/ErrorBoundary';
import { useEffectiveDisplayCondition } from '@features/display/useEffectiveDisplayCondition';
import { MapReparseWorker } from '@features/library/MapReparseWorker';
import { PdfPrerenderWorker } from '@features/map/PdfPrerenderWorker';
import { PdfRasterizerProvider } from '@features/map/PdfRasterizer';
import { PdfRecoverySnackbar } from '@features/map/PdfRecoverySnackbar';
import { installStravaAutoImport } from '@features/import/autoImport';
import { ImportFeedbackSnackbar } from '@features/share/ImportFeedbackSnackbar';
import { StravaPushPrompt } from '@features/strava/StravaPushPrompt';
import { GnssHost } from '@features/gnss/GnssHost';
import { installErrorReporting, reportError } from '@lib/errorReporting';
import { sweepUnfinishedTips } from '@lib/iap';
import { useImportStore } from '@state/importStore';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { useStravaStore } from '@state/stravaStore';
import { useSupportStore } from '@state/supportStore';
import { DisplayConditionContext } from '@ui/displayCondition';
import { resolveTheme } from '@ui/theme';
import { useAndroidImmersive } from '@ui/useAndroidImmersive';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { installTileHostAlias } from '@data/tileHostAlias';
import { clearPhotoInbox } from '@data/photos/inbox';
import { PhotoResizeHost } from '@features/photos/PhotoResizeHost';
import { AddPhotosAfterSavePrompt } from '@features/photos/AddPhotosAfterSavePrompt';

// Before any map mounts: MapLibre's requests for the frozen tile-template host
// go to wherever the Worker lives (a no-op until it moves; P1-2).
installTileHostAlias();

// Before anything mounts (#587): the photo resize inbox is served over
// loopback and holds full-resolution picks WITH their EXIF/GPS; anything left
// there by a crash or a kill mid-import goes now, before the resize host
// writes its page there and before any import can start.
clearPhotoInbox();

export default function RootLayout() {
  const osScheme = useColorScheme();
  // User theme choice ('system' follows the OS). Before hydration this reads
  // the default 'system', so a forced theme applies one render after launch —
  // visually a non-event because the splash still covers the first frames.
  const themeMode = useSettingsStore((s) => s.themeMode);
  const scheme = themeMode === 'system' ? (osScheme ?? 'light') : themeMode;
  // Display mode (decision 4): Sunlight and Night red override light/dark.
  const condition = useEffectiveDisplayCondition();
  const theme = resolveTheme(scheme === 'dark' ? 'dark' : 'light', condition);

  const hydrateLibrary = useLibraryStore((s) => s.hydrate);
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  const hydrateStrava = useStravaStore((s) => s.hydrate);
  const hydrateImports = useImportStore((s) => s.hydrate);

  useEffect(() => {
    // Global "no silent fails" hooks: fatal/non-fatal JS errors, unhandled
    // promise rejections, launch/foreground queue flushes. Idempotent.
    installErrorReporting();
    // FIRST, before anything else: if a crashed session (or the vc44 crash
    // loop — missing RECEIVE_BOOT_COMPLETED) left the OS location task
    // registered, stop it before the next GPS fix can kill the process.
    cleanupBackgroundLocationAtLaunch().catch((err) => reportError(err, 'bg-task-cleanup'));
    hydrateLibrary().catch((err) => reportError(err, 'library-hydrate'));
    hydrateSettings().catch((err) => reportError(err, 'settings-hydrate'));
    hydrateStrava().catch((err) => reportError(err, 'strava-hydrate'));
    hydrateImports().catch((err) => reportError(err, 'imports-hydrate'));
    useSupportStore
      .getState()
      .hydrate()
      .catch((err) => reportError(err, 'support-hydrate'));
  }, [hydrateLibrary, hydrateSettings, hydrateStrava, hydrateImports]);

  // A launch hydration that fails (an I/O error — a corrupt file hydrates
  // empty instead) leaves the library refusing every write, and settings
  // holding every change in memory, for the rest of the process. Try again
  // whenever the app comes back to the foreground; recording's Stop retries
  // the library too.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (!useLibraryStore.getState().hydrated) {
        hydrateLibrary().catch((err) => reportError(err, 'library-hydrate'));
      }
      if (!useSettingsStore.getState().hydrated) {
        hydrateSettings().catch((err) => reportError(err, 'settings-hydrate'));
      }
    });
    return () => subscription.remove();
  }, [hydrateLibrary, hydrateSettings]);

  // Strava auto-import (#432): quietly fetch new activities on launch and on
  // each return to the foreground (at most every 15 minutes).
  useEffect(() => installStravaAutoImport(), []);

  // Tips (#476) are consumables: one left unfinished by a killed session, or
  // an Android payment that cleared while the app was closed, is consumed
  // here — Play refunds what stays unacknowledged for three days. Deferred so
  // it never competes with launch; a no-op in builds without the store module.
  useEffect(() => {
    const timer = setTimeout(() => {
      sweepUnfinishedTips((tip) => useSupportStore.getState().recordTip(tip)).catch((err) =>
        reportError(err, 'tip-sweep'),
      );
    }, 15_000);
    return () => clearTimeout(timer);
  }, []);

  useAndroidImmersive();

  // Files opened via the OS "Open with" flow are handled in app/+native-intent.tsx
  // (redirectSystemPath), which intercepts the URI before expo-router routes it.

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <DisplayConditionContext.Provider value={condition}>
          <PaperProvider theme={theme}>
            <ErrorBoundary>
              <PdfRasterizerProvider>
                <StatusBar style={theme.dark ? 'light' : 'dark'} />
                <Stack
                  screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: theme.colors.background },
                  }}
                >
                  <Stack.Screen name="(tabs)" />
                  <Stack.Screen name="trail3d/[id]" />
                  {/* Trail photos (#587): the full-screen viewer, always on black. */}
                  <Stack.Screen
                    name="photo/[trackId]/[photoId]"
                    options={{ contentStyle: { backgroundColor: 'black' }, animation: 'fade' }}
                  />
                  <Stack.Screen name="settings" />
                  {/* Logbook statistics: Statistics, Personal records, Year in review. */}
                  <Stack.Screen name="logbook/stats" />
                  <Stack.Screen name="logbook/records" />
                  <Stack.Screen name="logbook/year" />
                  {/* Support Inukshuk: the tip jar and its thank-you (#476). */}
                  <Stack.Screen name="support/index" />
                  <Stack.Screen name="support/thanks" />
                  <Stack.Screen name="support/donor" />
                  <Stack.Screen name="support/verify" />
                  {/* The Explore tab's secondary screens (#447). */}
                  <Stack.Screen name="explore/list" />
                  <Stack.Screen name="explore/map" />
                  <Stack.Screen name="explore/item/[id]" />
                  <Stack.Screen name="explore/collection/[id]" />
                  {/* Long-distance trails (#467). */}
                  <Stack.Screen name="explore/trails" />
                  <Stack.Screen name="explore/trail/[id]" />
                  {/* Convert: coordinates, heights, epochs, chart datum (pinned PROJ pipelines). */}
                  <Stack.Screen name="convert" />
                  <Stack.Screen name="convert-selftest" />
                  {/* External GNSS receiver (#588): Settings › Extensions sub-screens. */}
                  <Stack.Screen name="gnss/pair" />
                  <Stack.Screen name="gnss/corrections" />
                  <Stack.Screen name="gnss/datum" />
                </Stack>
                <ImportFeedbackSnackbar />
                <PdfRecoverySnackbar />
                <PdfPrerenderWorker />
                <PhotoResizeHost />
                <MapReparseWorker />
                <StravaPushPrompt />
                <GnssHost />
                <AddPhotosAfterSavePrompt />
              </PdfRasterizerProvider>
            </ErrorBoundary>
          </PaperProvider>
        </DisplayConditionContext.Provider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
