/**
 * Team chat → Threads (#589, owner 2026-10-07): the conversations that hang
 * off a place — a shared photo's comments, a pinned message's replies, a
 * shared trail's thread — apart from the general channel. One row each:
 * thumbnail or icon, title, the last message, how many are new. Tapping a row
 * opens that thread (a photo's card on the map, the pin's card, the trail's
 * screen); the locate button jumps to its spot on the map.
 */
import { shortAge } from '@core/teamui/positions';
import type { ThreadRow } from '@core/teamui/threads';
import { teamService, useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { FlatList, Image, Pressable, StyleSheet, View } from 'react-native';
import { Icon, IconButton, Text } from 'react-native-paper';

import { usePhotoCard } from '../photos/PhotoBottomCard';
import { useNow } from './components';
import { useTeamMapFocus } from './map/teamMapFocus';

const ICON: Record<ThreadRow['target']['kind'], string> = {
  photo: 'image-outline',
  pin: 'map-marker-account-outline',
  trail: 'map-marker-path',
};

export function ChatThreads() {
  const t = useSchemeTokens();
  const router = useRouter();
  const view = useTeamStore((s) => s.view);
  const dataVersion = useTeamStore((s) => s.dataVersion);
  // Seen-marks move without a data op: re-read with the unread total too.
  const threadsUnread = useTeamStore((s) => s.threadsUnread);
  const now = useNow(60_000);
  const rows = useMemo(
    () => teamService()?.active?.threads() ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataVersion, threadsUnread],
  );
  if (view === null) return null;
  const nameOf = (id: string) =>
    id === view.me ? 'You' : (view.members.find((m) => m.id === id)?.name ?? 'A teammate');

  const locate = (r: ThreadRow) => {
    const at = r.target.at;
    if (!at) return;
    useTeamMapFocus.getState().focus(at[0], at[1], 16);
    router.navigate('/');
  };
  const open = (r: ThreadRow) => {
    teamService()?.active?.markSeen(r.key);
    useTeamStore.getState().refresh();
    const x = r.target;
    if (x.kind === 'photo') {
      locate(r);
      // Once the map is back: the tap that opened the thread must not also
      // land on the map, which closes a card on a bare tap.
      setTimeout(
        () =>
          usePhotoCard
            .getState()
            .show({ kind: 'team', owner: x.owner, trackId: x.trackId, photoId: x.photoId }),
        400,
      );
    } else if (x.kind === 'pin') {
      router.push(`/team/pin/${x.owner}/${x.id}` as never);
    } else {
      router.push(`/team/trail/${x.owner}/${x.trackId}` as never);
    }
  };

  return (
    <FlatList
      style={styles.flex}
      contentContainerStyle={styles.list}
      data={rows}
      keyExtractor={(r) => r.key}
      testID="team-threads"
      ListEmptyComponent={
        <Text variant="bodyMedium" style={[styles.empty, { color: t.inkVariant }]}>
          No threads yet. Comments on a shared photo or trail, and replies to a pinned message,
          gather here.
        </Text>
      }
      renderItem={({ item: r }) => (
        <Pressable
          onPress={() => open(r)}
          style={[styles.row, { backgroundColor: t.surfaceVariant, opacity: r.resolved ? 0.6 : 1 }]}
          accessibilityRole="button"
          accessibilityLabel={`${r.title}, ${r.count} message${r.count === 1 ? '' : 's'}${
            r.unread > 0 ? `, ${r.unread} new` : ''
          }`}
          testID="team-thread-row"
        >
          {r.thumbUri ? (
            <Image source={{ uri: r.thumbUri }} style={styles.thumb} />
          ) : (
            <View style={[styles.thumb, styles.icon, { backgroundColor: t.surface }]}>
              <Icon source={ICON[r.target.kind]} size={24} color={t.inkVariant} />
            </View>
          )}
          <View style={styles.flex}>
            <View style={styles.titleRow}>
              <Text variant="titleSmall" style={[styles.flex, { color: t.ink }]} numberOfLines={1}>
                {r.title}
              </Text>
              <Text variant="labelSmall" style={{ color: t.inkMuted }}>
                {shortAge(now - r.last.at)}
              </Text>
            </View>
            <Text
              variant="bodySmall"
              style={{ color: r.unread > 0 ? t.ink : t.inkVariant }}
              numberOfLines={1}
            >
              {/* A one-message thread's text is its title: say who instead. */}
              {r.count > 1 ? `${nameOf(r.last.author)}: ${r.last.text}` : nameOf(r.last.author)}
            </Text>
            <Text variant="labelSmall" style={{ color: t.inkMuted }}>
              {`${r.target.kind === 'photo' ? 'Photo' : r.target.kind === 'pin' ? 'Pin' : 'Trail'} · ${
                r.count
              } message${r.count === 1 ? '' : 's'}${r.resolved ? ' · resolved' : ''}`}
            </Text>
          </View>
          <View style={styles.right}>
            {r.unread > 0 && (
              <View style={[styles.badge, { backgroundColor: t.team.bubbleNew }]}>
                <Text style={[styles.badgeText, { color: t.team.bubbleNewInk }]}>
                  {r.unread > 99 ? '99+' : r.unread}
                </Text>
              </View>
            )}
            {r.target.at && (
              <IconButton
                icon="crosshairs-gps"
                size={18}
                onPress={() => locate(r)}
                accessibilityLabel={`Show “${r.title}” on the map`}
                testID="team-thread-locate"
              />
            )}
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: 16, gap: 8 },
  empty: { textAlign: 'center', paddingVertical: 32 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, borderRadius: 12 },
  thumb: { width: 52, height: 52, borderRadius: 10 },
  icon: { alignItems: 'center', justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  right: { alignItems: 'center' },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 12, fontWeight: '800', includeFontPadding: false },
});
