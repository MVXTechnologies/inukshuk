// This import is FIRST deliberately: loading @lib/backgroundLocation
// registers the background-location task (TaskManager.defineTask) at module
// scope, so a headless launch — Android killing and relaunching the app
// mid-recording — re-registers the handler before any UI mounts.
import { cleanupBackgroundLocationAtLaunch } from '@lib/backgroundLocation';

import { ErrorBoundary } from '@features/common/components/ErrorBoundary';
import { PdfRasterizerProvider } from '@features/map/PdfRasterizer';
import { ImportFeedbackSnackbar } from '@features/share/ImportFeedbackSnackbar';
import { StravaPushPrompt } from '@features/strava/StravaPushPrompt';
import { installErrorReporting, reportError } from '@lib/errorReporting';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { useStravaStore } from '@state/stravaStore';
import { resolveTheme } from '@ui/theme';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function RootLayout() {
  const osScheme = useColorScheme();
  // User theme choice ('system' follows the OS). Before hydration this reads
  // the default 'system', so a forced theme applies one render after launch —
  // visually a non-event because the splash still covers the first frames.
  const themeMode = useSettingsStore((s) => s.themeMode);
  const uiStyle = useSettingsStore((s) => s.uiStyle);
  const scheme = themeMode === 'system' ? (osScheme ?? 'light') : themeMode;
  const theme = resolveTheme(uiStyle, scheme === 'dark' ? 'dark' : 'light');

  const hydrateLibrary = useLibraryStore((s) => s.hydrate);
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  const hydrateStrava = useStravaStore((s) => s.hydrate);

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
  }, [hydrateLibrary, hydrateSettings, hydrateStrava]);

  // Files opened via the OS "Open with" flow are handled in app/+native-intent.tsx
  // (redirectSystemPath), which intercepts the URI before expo-router routes it.

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <PaperProvider theme={theme}>
          <ErrorBoundary>
            <PdfRasterizerProvider>
              <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: theme.colors.background },
                }}
              >
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="trail3d/[id]" />
              </Stack>
              <ImportFeedbackSnackbar />
              <StravaPushPrompt />
            </PdfRasterizerProvider>
          </ErrorBoundary>
        </PaperProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
