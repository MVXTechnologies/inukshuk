import * as NavigationBar from 'expo-navigation-bar';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

/**
 * Android: keep the system navigation bar (Back / Home / Recents, or the
 * gesture handle) hidden, so the app's own tab bar sits at the bottom of the
 * screen instead of stacked on top of the OS buttons (owner call,
 * 2026-09-28). It stays one swipe away: a swipe up from the bottom edge
 * shows it transiently (BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE), and Android
 * hides it again by itself. Re-applied when the app comes back to the
 * foreground, which can restore the bar. The config plugin
 * (`expo-navigation-bar` { hidden: true }) starts the app hidden, so there
 * is no flash at launch. No-op on iOS.
 */
export function useAndroidImmersive(): void {
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const hide = () => {
      try {
        NavigationBar.NavigationBar.setHidden(true);
      } catch {
        // Cosmetic: never let the system bar break the app.
      }
    };
    hide();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') hide();
    });
    return () => sub.remove();
  }, []);
}
