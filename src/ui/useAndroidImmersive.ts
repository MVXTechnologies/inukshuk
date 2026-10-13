import * as NavigationBar from 'expo-navigation-bar';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

/**
 * Android: the system navigation bar (Back / Home / Recents, or the gesture
 * handle). By default it stays hidden, so the app's own tab bar sits at the
 * bottom of the screen instead of stacked on top of the OS buttons (owner
 * call, 2026-09-28). It is one swipe away: a swipe up from the bottom edge
 * shows it for a moment (BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE), then
 * Android hides it again.
 *
 * Settings › Display › "Show phone navigation buttons" (#682) keeps it
 * visible instead. Every bottom-anchored surface pads by the safe-area
 * inset, so nothing sits under the bar when it is up.
 *
 * Either way the choice is re-applied when the app comes back to the
 * foreground, because the OS can change the bar while we are away. The
 * config plugin (`expo-navigation-bar` { hidden: true }) starts the app
 * hidden, so the default has no flash at launch. With the setting on, the
 * bar appears once settings have hydrated (the first frames after launch).
 *
 * `setVisibilityAsync` (deprecated in SDK 56) and not the static
 * `NavigationBar.setHidden`: the static one skips the native call when its
 * JS-side cache already holds the value, and that cache goes stale whenever
 * the native side moves the bar (the plugin's onCreate hide, the OS on
 * resume). The resume re-apply would then never reach Android. Should a
 * later SDK drop it, this import stops typechecking, which is the cue to
 * revisit.
 *
 * `showBar` comes from the caller (the root layout reads the setting), so
 * this glue stays free of app state. No-op on iOS.
 */
export function useAndroidImmersive(showBar: boolean): void {
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const apply = () => {
      try {
        NavigationBar.setVisibilityAsync(showBar ? 'visible' : 'hidden').catch(() => {
          // Cosmetic: never let the system bar break the app.
        });
      } catch {
        // Same: a synchronous throw from the native module is swallowed too.
      }
    };
    apply();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') apply();
    });
    return () => sub.remove();
  }, [showBar]);
}
