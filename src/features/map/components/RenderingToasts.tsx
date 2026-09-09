import { renderingToasts, type HiddenToasts } from '@core/library/renderingToasts';
import { useLibraryStore } from '@state/libraryStore';
import { useOverlayStatusStore } from '@state/overlayStatusStore';
import { useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { IconButton, Text, useTheme } from 'react-native-paper';

/**
 * "Rendering <map> — page N…" rows while PDF pages are in the rasterizer
 * (#269). Lives in the map's bottom chrome column, so it stacks above the
 * scale bar and recording bar instead of overlapping them. Each row hides
 * with its own button; a hide lasts only as long as that render (see
 * `HiddenToasts`).
 *
 * A plain themed View, not a Paper Surface: absolutely-positioned Surfaces
 * collapse their flex columns on iOS.
 */
export function RenderingToasts() {
  const theme = useTheme();
  const maps = useLibraryStore((s) => s.maps);
  const statuses = useOverlayStatusStore((s) => s.statuses);
  const [hidden, setHidden] = useState<HiddenToasts>(() => new Map());

  const rows = useMemo(() => renderingToasts(maps, statuses, hidden), [maps, statuses, hidden]);
  if (rows.length === 0) return null;

  return (
    <View style={styles.column} pointerEvents="box-none">
      {rows.map((row) => (
        <View
          key={row.key}
          style={[styles.row, { backgroundColor: theme.colors.surfaceVariant }]}
          accessible
          accessibilityLabel={row.text}
        >
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <Text
            variant="bodySmall"
            numberOfLines={1}
            style={[styles.text, { color: theme.colors.onSurfaceVariant }]}
          >
            {row.text}
          </Text>
          <IconButton
            icon="close"
            size={16}
            style={styles.close}
            onPress={() =>
              setHidden((h) => {
                const status = statuses[row.key];
                return status ? new Map(h).set(row.key, status) : h;
              })
            }
            accessibilityLabel={`Hide: ${row.text}`}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  column: { gap: 6, alignItems: 'flex-start' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 12,
    paddingRight: 2,
    paddingVertical: 2,
    borderRadius: 14,
    maxWidth: '100%',
  },
  text: { flexShrink: 1 },
  close: { margin: 0 },
});
