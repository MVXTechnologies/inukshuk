import { useState } from 'react';
import { FAB, useTheme } from 'react-native-paper';
import { InukshukIcon } from './InukshukIcon';

interface Props {
  onRecord: () => void;
  /** Drop a standalone waypoint at the current GPS position (no recording needed). */
  onAddWaypoint: () => void;
}

/**
 * The bottom-right "+" speed-dial (start recording, drop a waypoint; room for
 * more map actions later — plan a route, import…).
 */
export function MapActionsFab({ onRecord, onAddWaypoint }: Props) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
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
      actions={[
        {
          // The app's inukshuk glyph — paper accepts a render function
          // anywhere a MaterialCommunityIcons name goes.
          icon: ({ size, color }) => <InukshukIcon size={size} color={color} />,
          label: 'Add waypoint',
          containerStyle: { marginVertical: -2 },
          onPress: () => {
            setOpen(false);
            onAddWaypoint();
          },
        },
        {
          icon: 'timer-outline',
          label: 'Record track',
          containerStyle: { marginVertical: -2 },
          onPress: () => {
            setOpen(false);
            onRecord();
          },
        },
      ]}
      onStateChange={({ open: o }) => setOpen(o)}
      accessibilityLabel="Map actions"
    />
  );
}
