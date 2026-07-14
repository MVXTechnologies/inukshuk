// Side-effect import FIRST: registers the background-location task
// (TaskManager.defineTask) at module scope, so a headless launch — Android
// killing and relaunching the app mid-recording — re-registers the handler
// before any UI mounts. See src/lib/backgroundLocation.ts.
import '@lib/backgroundLocation';

import { ErrorBoundary } from '@features/common/components/ErrorBoundary';
import { ErrorReportPrompt } from '@features/common/components/ErrorReportPrompt';
import { PdfRasterizerProvider } from '@features/map/PdfRasterizer';
import { ImportFeedbackSnackbar } from '@features/share/ImportFeedbackSnackbar';
import { installErrorReporting, reportError } from '@lib/errorReporting';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { darkTheme, lightTheme } from '@ui/theme';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function RootLayout() {
  const scheme = useColorScheme();
  const theme = scheme === 'dark' ? darkTheme : lightTheme;

  const hydrateLibrary = useLibraryStore((s) => s.hydrate);
  const hydrateSettings = useSettingsStore((s) => s.hydrate);

  useEffect(() => {
    // Global "no silent fails" hooks: fatal/non-fatal JS errors, unhandled
    // promise rejections, launch/foreground queue flushes. Idempotent.
    installErrorReporting();
    hydrateLibrary().catch((err) => reportError(err, 'library-hydrate'));
    hydrateSettings().catch((err) => reportError(err, 'settings-hydrate'));
  }, [hydrateLibrary, hydrateSettings]);

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
              <ErrorReportPrompt />
            </PdfRasterizerProvider>
          </ErrorBoundary>
        </PaperProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
