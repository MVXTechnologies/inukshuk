/**
 * A pin's card on the map (#589, mockup `b-map-pin`): who pinned it, whether
 * it is on a shown trail or how far off, how far from me; its thread with the
 * tasks made from it as chips; a reply box (`+task @name …` assigns, anchored
 * to the pin) and "New task here". A plain themed View
 * (paper-surface-ios-flex-collapse).
 */
import { distanceToLine, ON_TRAIL_M, type TeamPin } from '@core/teamui/pins';
import { rangeAndBearing } from '@core/teamui/positions';
import type { TeamView } from '@core/teamui/view';
import { teamService, useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, IconButton, Text } from 'react-native-paper';

import { MemberAvatar } from '../components';
import { sendTeamComment } from '../taskSend';
import { TeamComments } from '../TeamComments';
import { useToggleTask } from '../useToggleTask';

const dist = (m: number) =>
  m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;

/** "On the trail", or "120 m off the trail", against the team's shared trails. */
export function pinPlace(
  pin: { lng: number; lat: number },
  lines: readonly (readonly [number, number])[][],
): string | null {
  if (lines.length === 0) return null;
  const d = Math.min(...lines.map((l) => distanceToLine(pin.lng, pin.lat, l)));
  if (!Number.isFinite(d)) return null;
  return d <= ON_TRAIL_M ? 'on the trail' : `${dist(d)} off the trail`;
}

export function TeamPinCard({
  pin,
  view,
  here,
  onClose,
}: {
  pin: TeamPin;
  view: TeamView;
  here: { latitude: number; longitude: number } | null;
  onClose: () => void;
}) {
  const t = useSchemeTokens();
  const router = useRouter();
  const tasks = useTeamStore((s) => s.tasks);
  const tracks = useTeamStore((s) => s.shares.tracks);
  const toggle = useToggleTask();
  const session = teamService()?.active ?? null;
  const owner = view.members.find((m) => m.id === pin.owner);
  const lines = useMemo(() => tracks.flatMap((tr) => tr.parts), [tracks]);
  const place = pinPlace(pin, lines);
  const rb = here ? rangeAndBearing(here, { lat: pin.lat, lon: pin.lng }) : null;
  const lastAt = pin.lastAt;
  useEffect(() => {
    session?.markSeen(`pin:${pin.owner}:${pin.id}`);
  }, [session, pin.owner, pin.id, lastAt]);
  const comments = pin.messages.map((m) => ({
    id: m.id,
    author: m.author,
    photoId: null,
    trackId: '',
    text: m.text,
    at: m.at,
    mentions: m.mentions,
  }));
  const ownerName = pin.owner === view.me ? 'you' : (owner?.name ?? 'a teammate');
  const sub = [
    `Pinned by ${ownerName}`,
    place,
    rb ? `${dist(rb.meters)} ${rb.compass} of you` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const canGive = view.members.find((m) => m.id === view.me)?.role !== 'guest';

  return (
    <View
      style={[styles.card, { backgroundColor: t.elevation.level2, shadowColor: palette.shadow }]}
      testID="team-pin-card"
    >
      <View style={styles.head}>
        <MemberAvatar
          initials={owner?.initials ?? '?'}
          color={owner?.color ?? t.inkMuted}
          size={34}
        />
        <View style={styles.flex}>
          <Text variant="titleMedium" style={{ color: t.ink }}>
            Message here
          </Text>
          <Text variant="bodySmall" style={{ color: t.inkVariant }}>
            {sub}
          </Text>
        </View>
        <IconButton icon="close" onPress={onClose} accessibilityLabel="Close" />
      </View>
      <ScrollView style={styles.thread} keyboardShouldPersistTaps="handled">
        {session && (
          <TeamComments
            comments={comments}
            members={view.members}
            me={view.me}
            canWrite={view.active && !view.readOnly}
            placeholder="Reply here, or +task @name"
            tasks={tasks}
            onToggleTask={toggle}
            onSend={(text, mentions) =>
              sendTeamComment({
                session,
                text,
                members: view.members,
                anchor: { kind: 'pin', owner: pin.owner, id: pin.id },
                write: (id) => session.replyToPin(pin.owner, pin.id, text, mentions, id),
              })
            }
            testID="team-pin-thread"
          />
        )}
      </ScrollView>
      {canGive && (
        <Button
          mode="text"
          icon="checkbox-marked-circle-plus-outline"
          compact
          style={styles.newTask}
          onPress={() => router.push(`/team/task-new?ak=pin&ao=${pin.owner}&ai=${pin.id}` as never)}
          testID="team-pin-new-task"
        >
          New task here
        </Button>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: {
    borderRadius: 16,
    padding: 12,
    gap: 6,
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  thread: { maxHeight: 280 },
  newTask: { alignSelf: 'flex-start' },
});
