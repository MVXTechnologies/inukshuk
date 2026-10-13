import { useRecorderStore } from '@state/recorderStore';
import { useWaypointMoveStore } from '@state/waypointMoveStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * The bottom inset a sheet docked at the Map screen's bottom edge must pad by
 * itself (#682). Normally the tab bar sits below the Map screen and already
 * absorbs the system inset, so this is 0 (padding again would double-pay it,
 * the Wave A dock-gap bug). While recording or moving a waypoint the tabs
 * layout hides the tab bar on the Map, the screen reaches the window's bottom
 * edge, and the system navigation bar (kept on screen on Android by
 * Settings › Display, or the iOS home indicator) would cover the sheet: then
 * it is the safe-area inset. Keep the predicate in step with
 * app/(tabs)/_layout.tsx.
 */
export function useMapBottomInset(): number {
  const insets = useSafeAreaInsets();
  const recording = useRecorderStore((s) => s.status !== 'idle');
  const moving = useWaypointMoveStore((s) => s.moving !== null);
  return recording || moving ? insets.bottom : 0;
}
