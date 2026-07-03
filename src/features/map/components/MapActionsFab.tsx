import { useState } from 'react';
import { FAB, useTheme } from 'react-native-paper';

interface Props {
  onRecord: () => void;
}

/**
 * The bottom-right "+" speed-dial (start recording today; room for more map
 * actions later — plan a route, drop a destination pin, import…).
 */
export function MapActionsFab({ onRecord }: Props) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <FAB.Group
      open={open}
      visible
      icon={open ? 'close' : 'plus'}
      color={theme.colors.onTertiary}
      fabStyle={{ backgroundColor: theme.colors.tertiary }}
      backdropColor="#00000066"
      actions={[
        {
          icon: 'record-circle',
          label: 'Record track',
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
