/**
 * The Connection sheet (#705, mockup G7 screen 4), from the team panel's
 * connection chip: this phone (internet, nearby), then each teammate with
 * how it is reached and why, the ONE end-to-end encryption line of the app
 * (owner 2026-10-15), and the way into the Connection screen.
 */
import { linkReason } from '@core/teamui/links';
import { useSettingsStore } from '@state/settingsStore';
import { useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { LinkChip, MemberAvatar, useNow } from '../components';
import { Card } from './TeamCards';

/** This phone's internet line, from the team's room state. */
export function internetLine(
  room: string,
  online: boolean,
  capable = true,
): { text: string; ok: boolean } {
  if (!capable) return { text: 'Not available on this phone', ok: false };
  if (room === 'ready') return { text: 'Connected', ok: true };
  if (room === 'failing') return { text: 'No internet', ok: false };
  return { text: online ? 'Connecting…' : 'Paused while the app is closed', ok: false };
}

export function ConnectionCard({ onClose }: { onClose: () => void }) {
  const t = useSchemeTokens();
  const router = useRouter();
  const now = useNow(30_000);
  const view = useTeamStore((s) => s.view);
  const net = useTeamStore((s) => s.net);
  const alwaysRelay = useSettingsStore((s) => s.teamAlwaysRelay);
  if (view === null || net === null) return null;
  const mates = view.members.filter((m) => m.active && !m.isMe);
  const reachable = mates.filter((m) => {
    const l = net.links.get(m.id);
    return l === 'direct' || l === 'relay' || l === 'nearby';
  }).length;
  const nearby = mates.filter((m) => net.links.get(m.id) === 'nearby').length;
  const inet = internetLine(net.room, net.online, net.capable);

  return (
    <Card
      title="Connection"
      sub={`${view.name} · ${reachable} of ${mates.length} reachable`}
      onClose={onClose}
      testID="team-connection-card"
    >
      <Text style={[styles.label, { color: t.inkMuted }]}>This phone</Text>
      <Row
        icon="web"
        title="Internet"
        line={inet.text}
        tone={inet.ok ? t.status.gnssFixed : t.inkVariant}
        testID="team-connection-internet"
      />
      <Row
        icon="access-point"
        title="Nearby"
        line={nearby === 0 ? 'No phone nearby' : `${nearby} phone${nearby === 1 ? '' : 's'} nearby`}
        tone={nearby > 0 ? t.status.gnssFixed : t.inkVariant}
      />
      <Text style={[styles.label, { color: t.inkMuted }]}>Teammates</Text>
      <ScrollView style={styles.list}>
        {mates.map((m) => {
          const link = net.links.get(m.id) ?? 'out';
          return (
            <View key={m.id} style={styles.row} testID={`team-connection-${m.name}`}>
              <MemberAvatar initials={m.initials} color={m.color} size={32} />
              <View style={styles.flex}>
                <Text
                  variant="bodyMedium"
                  style={[styles.name, { color: t.ink }]}
                  numberOfLines={1}
                >
                  {m.name}
                </Text>
                <Text variant="bodySmall" style={{ color: t.inkVariant }} numberOfLines={2}>
                  {linkReason(link, { alwaysRelay, lastSeenAt: m.lastSeenAt, now })}
                </Text>
              </View>
              <LinkChip link={link} />
            </View>
          );
        })}
      </ScrollView>
      <View
        style={[styles.e2e, { backgroundColor: t.surfaceVariant }]}
        testID="team-connection-e2e"
      >
        <Icon source="lock" size={16} color={t.ink} />
        <Text variant="bodySmall" style={[styles.flex, { color: t.inkVariant }]}>
          <Text variant="bodySmall" style={[styles.strong, { color: t.ink }]}>
            End-to-end encrypted, on every path.
          </Text>{' '}
          The relay sees which phones talk, when and how much, never what they say or where anyone
          is.
        </Text>
      </View>
      <Pressable
        onPress={() => {
          onClose();
          router.push('/team/connection' as never);
        }}
        style={[styles.settings, { borderTopColor: t.outlineVariant }]}
        accessibilityRole="button"
        testID="team-connection-settings"
      >
        <Icon source="tune-variant" size={20} color={t.inkVariant} />
        <View style={styles.flex}>
          <Text variant="bodyMedium" style={[styles.name, { color: t.ink }]}>
            Connection settings
          </Text>
          <Text variant="bodySmall" style={{ color: t.inkVariant }} numberOfLines={1}>
            {alwaysRelay ? 'Relay only on this phone' : 'Direct when possible'}
          </Text>
        </View>
        <Icon source="chevron-right" size={20} color={t.inkMuted} />
      </Pressable>
    </Card>
  );
}

function Row({
  icon,
  title,
  line,
  tone,
  testID,
}: {
  icon: string;
  title: string;
  line: string;
  tone: string;
  testID?: string;
}) {
  const t = useSchemeTokens();
  return (
    <View style={styles.row} testID={testID}>
      <Icon source={icon} size={20} color={t.inkVariant} />
      <View style={styles.flex}>
        <Text variant="bodyMedium" style={[styles.name, { color: t.ink }]}>
          {title}
        </Text>
        <Text variant="bodySmall" style={{ color: tone }} numberOfLines={1}>
          {line}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  label: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 2,
    paddingHorizontal: 4,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 4 },
  name: { fontWeight: '600' },
  strong: { fontWeight: '700' },
  list: { maxHeight: 220 },
  e2e: { flexDirection: 'row', gap: 8, padding: 10, borderRadius: 12 },
  settings: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 48,
    paddingHorizontal: 4,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
