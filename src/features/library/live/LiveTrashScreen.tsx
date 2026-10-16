import { shortAge } from '@core/teamui/positions';
import { GnssScreenFrame } from '@features/extensions/gnss/GnssScreenFrame';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from '@ui/paper';

import { liveService, refreshLive, useLiveFolders } from './useLive';
import { useScaledStyles } from '@ui/displayScale';

const ICON: Record<string, string> = {
  trk: 'map-marker-path',
  wpt: 'map-marker-outline',
  area: 'vector-polygon',
  map: 'map-outline',
};

/**
 * A shared folder's Recently deleted (#712, G10 mockup 8, R-LIB-1): deletes
 * stay here for 30 days on every phone; Restore brings an item back for
 * everyone (with any edit a delete beat).
 */
export function LiveTrashScreen() {
  const styles = useScaledStyles(stylesSheet);

  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = typeof id === 'string' ? id : '';
  const t = useSchemeTokens();
  const list = useLiveFolders();
  const live = liveService();
  const entries = useMemo(
    () => live?.trash(groupId) ?? [],
    // Re-read whenever the folders change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live, groupId, list],
  );
  const [now] = useState(() => Date.now());
  return (
    <GnssScreenFrame title="Recently deleted" testID="live-trash-screen">
      {entries.length === 0 && (
        <Text style={[styles.empty, { color: t.inkMuted }]}>
          Nothing deleted in the last 30 days.
        </Text>
      )}
      {entries.map((e) => {
        const type = typeof e.node.fields['t'] === 'string' ? e.node.fields['t'] : 'folder';
        return (
          <View
            key={e.node.id}
            style={[styles.row, { borderBottomColor: t.divider }]}
            testID="live-trash-row"
          >
            <View style={[styles.tile, { backgroundColor: t.surfaceVariant }]}>
              <Icon source={ICON[type] ?? 'folder-outline'} size={26} color={t.ink} />
            </View>
            <View style={styles.text}>
              <Text numberOfLines={1} style={[styles.name, { color: t.ink }]}>
                {e.node.name}
              </Text>
              <Text numberOfLines={1} style={[styles.caption, { color: t.inkMuted }]}>
                {`Deleted by ${e.by} · ${shortAge(now - e.since.wall)}`}
              </Text>
            </View>
            <Pressable
              onPress={() => {
                live?.restore(groupId, e.node.kind, e.node.id);
                refreshLive();
              }}
              accessibilityRole="button"
              accessibilityLabel={`Restore ${e.node.name}`}
              testID="live-trash-restore"
              style={[styles.button, { borderColor: t.outline }]}
            >
              <Text style={[styles.buttonLabel, { color: t.ink }]}>Restore</Text>
            </Pressable>
          </View>
        );
      })}
    </GnssScreenFrame>
  );
}

const stylesSheet = StyleSheet.create({
  empty: { fontSize: 14, lineHeight: 20, fontWeight: '600', marginTop: space.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 64,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
  },
  tile: { width: 56, height: 56, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, minWidth: 0 },
  name: { fontSize: 15.5, lineHeight: 20, fontWeight: '700' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
  button: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    justifyContent: 'center',
  },
  buttonLabel: { fontSize: 13, fontWeight: '800' },
});
