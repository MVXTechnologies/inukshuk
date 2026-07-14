// Side-effect import FIRST: registers the background-location task
// (TaskManager.defineTask) at module scope, so a headless launch — Android
// killing and relaunching the app mid-recording — re-registers the handler
// before any UI mounts. See src/lib/backgroundLocation.ts.
import '@lib/backgroundLocation';

import { PdfRasterizerProvider } from '@features/map/PdfRasterizer';
import { ImportFeedbackSnackbar } from '@features/share/ImportFeedbackSnackbar';
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
    void hydrateLibrary();
    void hydrateSettings();
  }, [hydrateLibrary, hydrateSettings]);

  // Files opened via the OS "Open with" flow are handled in app/+native-intent.tsx
  // (redirectSystemPath), which intercepts the URI before expo-router routes it.

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <PaperProvider theme={theme}>
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
          </PdfRasterizerProvider>
        </PaperProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
