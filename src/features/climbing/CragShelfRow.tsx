import { routesLabel } from '@core/climbing/card';
import { savedBytes, type SavedCrag } from '@core/climbing/saved';
import { formatBytes } from '@core/format';
import { useClimbingStore } from '@state/climbingStore';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { climbingActions } from './lazyActions';
import { cragHref } from './climbingRoutes';
import { CragBadge } from './ClimbingParts';

/**
 * A saved crag on the Library's Climbing shelf (owner decision Q9-A): name,
 * routes, size on the phone, when saved. Tap opens the topo; the ⋮ offers
 * Update and Delete.
 */
export function CragShelfRow({ crag }: { crag: SavedCrag }) {
  const t = useSchemeTokens();
  const router = useRouter();
  const busy = useClimbingStore((s) => s.downloads[crag.uid] !== undefined);
  const saved = new Date(crag.savedAt).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
  });
  const menu = () =>
    Alert.alert(crag.name, undefined, [
      {
        text: 'Update the topo',
        onPress: () =>
          void climbingActions()
            .then((a) => a.downloadCrag(crag.uid, { withMap: false }))
            .catch(() => undefined),
      },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          Alert.alert(
            `Delete ${crag.name}?`,
            'Its topo, its map and your attached topos leave this phone.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: () => void climbingActions().then((a) => a.removeCrag(crag.uid)),
              },
            ],
          ),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  return (
    <View style={styles.row} testID={`crag-shelf-${crag.uid}`}>
      <Pressable
        style={styles.main}
        onPress={() => router.push(cragHref(crag.uid))}
        onLongPress={menu}
        accessibilityRole="button"
        accessibilityLabel={`${crag.name}, climbing crag saved offline`}
      >
        <CragBadge size={44} saved />
        <View style={styles.text}>
          <Text numberOfLines={1} style={[styles.title, { color: t.ink }]}>
            {crag.name}
          </Text>
          <Text numberOfLines={1} style={[styles.meta, { color: t.inkMuted }]}>
            {busy
              ? 'Updating…'
              : [
                  crag.region,
                  routesLabel(crag.routes),
                  formatBytes(savedBytes(crag)),
                  `saved ${saved}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </Text>
        </View>
      </Pressable>
      <Pressable
        onPress={menu}
        accessibilityRole="button"
        accessibilityLabel={`More for ${crag.name}`}
        hitSlop={8}
        style={styles.more}
      >
        <Icon source="dots-vertical" size={22} color={t.inkVariant} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 64 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  meta: { fontSize: 13, lineHeight: 18 },
  more: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
