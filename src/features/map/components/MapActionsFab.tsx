import { useEffect, useMemo, useRef, useState } from 'react';
import { FAB, useTheme } from 'react-native-paper';
import { InukshukIcon } from './InukshukIcon';

interface Props {
  onRecord: () => void;
  /** Drop a standalone waypoint at the current GPS position (no recording needed). */
  onAddWaypoint: () => void;
  /**
   * Start the offline-area download (moved here from the rail to unclog it).
   * Omitted while unavailable — recording, region-select or a running
   * download — a second download would stop the first's loopback server.
   */
  onDownload?: () => void;
  /** Open the map maker (region box → options → PDF). Omitted in 3D. */
  onMakeMap?: () => void;
}

/**
 * The bottom-right "+" speed-dial (start recording, drop a waypoint; room for
 * more map actions later — plan a route, import…).
 */
export function MapActionsFab({ onRecord, onAddWaypoint, onDownload, onMakeMap }: Props) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  const propsRef = useRef({ onRecord, onAddWaypoint, onDownload, onMakeMap });
  useEffect(() => {
    propsRef.current = { onRecord, onAddWaypoint, onDownload, onMakeMap };
  });

  const hasDownload = onDownload !== undefined;
  const hasMakeMap = onMakeMap !== undefined;
  // Paper's FAB.Group restarts its open/close animation whenever the `actions`
  // array changes identity (the animation effect lists `actions` as a dep).
  // MapScreen re-renders many times a second while the compass or GPS ticks,
  // so building this array inline restarted the stagger mid-flight over and
  // over and the dial crawled open in slow motion. Keep the identity stable;
  // handlers read the live callbacks through propsRef.
  const actions = useMemo(
    () => [
      ...(hasMakeMap
        ? [
            {
              icon: 'map-plus',
              label: 'Make a map',
              containerStyle: { marginVertical: -2 },
              onPress: () => {
                setOpen(false);
                propsRef.current.onMakeMap?.();
              },
            },
          ]
        : []),
      ...(hasDownload
        ? [
            {
              icon: 'tray-arrow-down',
              label: 'Download offline area',
              containerStyle: { marginVertical: -2 },
              onPress: () => {
                setOpen(false);
                propsRef.current.onDownload?.();
              },
            },
          ]
        : []),
      {
        // The app's inukshuk glyph — paper accepts a render function
        // anywhere a MaterialCommunityIcons name goes.
        icon: ({ size, color }: { size: number; color: string }) => (
          <InukshukIcon size={size} color={color} />
        ),
        label: 'Add waypoint',
        containerStyle: { marginVertical: -2 },
        onPress: () => {
          setOpen(false);
          propsRef.current.onAddWaypoint();
        },
      },
      {
        icon: 'timer-outline',
        label: 'Record track',
        containerStyle: { marginVertical: -2 },
        onPress: () => {
          setOpen(false);
          propsRef.current.onRecord();
        },
      },
    ],
    [hasDownload, hasMakeMap],
  );

  return (
    <FAB.Group
      open={open}
      visible
      icon={open ? 'close' : 'plus'}
      color={theme.colors.onTertiary}
      // Circular like every rail FAB (paper's MD3 default is a squircle), and
      // actions pulled tighter to the dial.
      fabStyle={{ backgroundColor: theme.colors.tertiary, borderRadius: 28 }}
      backdropColor="#00000066"
      actions={actions}
      onStateChange={({ open: o }) => setOpen(o)}
      accessibilityLabel="Map actions"
    />
  );
}
