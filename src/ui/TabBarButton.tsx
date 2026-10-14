import { PlatformPressable } from 'expo-router/react-navigation';
import type { ComponentProps } from 'react';

type TabBarButtonProps = ComponentProps<typeof PlatformPressable>;

/**
 * The bottom tab bar's button: the library's own (`PlatformPressable`, same
 * ripple, roles and labels) minus `onLongPress`.
 *
 * Why: React Navigation wires every tab to `onLongPress` (a `tabLongPress`
 * event nobody here listens to), and RN's Pressability then drops `onPress`
 * whenever the release reaches JS more than 500 ms after the press-in — its
 * long-press timer is a JS `setTimeout`, so it measures how late the release
 * ARRIVES, not how long the finger stayed down. When the UI thread stalls
 * between a quick tap's DOWN and UP (map start-up, the first GPS fix, a slow
 * phone), the tap became a "long press" and the tab simply did not switch.
 * Seen as the gnss.yaml E2E flake: two taps on Library 1.3 s apart, each
 * straddling a 530-630 ms main-thread stall ("Skipped 38 frames"), neither
 * switched tabs.
 *
 * Without a long-press handler Pressability always ends in `onPress`, so a
 * tap on a tab always switches, however late its release is delivered.
 */
export function TabBarButton({ onLongPress: _unused, ...props }: TabBarButtonProps) {
  return <PlatformPressable {...props} />;
}
