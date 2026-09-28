import type { MapBasemap } from '@state/mapStore';
import { useChromeOutline } from '@ui/useChromeOutline';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { basemapAttribution } from '../mapStyle';

/** How long a tapped credit stays open before folding back to the ⓘ. */
export const CREDIT_OPEN_MS = 5000;

/**
 * The basemap's credit, bottom-right (owner call, 2026-09-28: no text over
 * the map — the full roll lives in Settings › System info). A small ⓘ opens
 * the short credit for a few seconds; OpenStreetMap's attribution guidelines
 * accept that on small screens, as long as it stays one tap away ON the map.
 */
export function AttributionChip({ basemap, vector }: { basemap: MapBasemap; vector: boolean }) {
  const tokens = useSchemeTokens();
  const outline = useChromeOutline();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setOpen(false), CREDIT_OPEN_MS);
    return () => clearTimeout(t);
  }, [open]);

  const credit = basemapAttribution(basemap, vector);
  return (
    <Pressable
      onPress={() => setOpen((o) => !o)}
      accessibilityRole="button"
      accessibilityLabel={open ? credit : 'Map data credits'}
      hitSlop={10}
      style={[styles.chip, open && styles.open, { backgroundColor: tokens.map.chip }, outline]}
    >
      {open ? (
        <Text style={[styles.label, { color: tokens.map.chipInkMuted }]}>{credit}</Text>
      ) : (
        <View style={styles.icon}>
          <Icon source="information-outline" size={16} color={tokens.map.chipInkMuted} />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { borderRadius: 14, minWidth: 28, height: 28, justifyContent: 'center' },
  open: { paddingHorizontal: 10 },
  icon: { alignItems: 'center' },
  label: { fontSize: 12 },
});
