/**
 * A teammate's card (#707, mockup "Tap a teammate"): from their marker on
 * the map or their row in the team panel. Their status, how fresh their
 * position is, distance, bearing and last fix; three actions — Message,
 * Navigate to (primary), Centre — and, below, Task and "Where are you?".
 * A plain themed View docked at the bottom (paper-surface-ios-flex-collapse).
 */
import { rangeAndBearing, shortAge, type TeammatePosition } from '@core/teamui/positions';
import { STATUS_LABEL } from '@core/teamui/system';
import { distanceText } from '@core/teamui/teamBar';
import type { MemberRow } from '@core/teamui/view';
import { formatAccuracy } from '@core/format';
import { useSettingsStore } from '@state/settingsStore';
import { teamService, useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, IconButton, Text } from '@ui/paper';

import { BandAvatar } from '../bar/parts';
import { useTeamMapFocus } from './teamMapFocus';
import { useScaledStyles } from '@ui/displayScale';

export function TeammateCard({
  member,
  row,
  here,
  onNavigate,
  onClose,
}: {
  member: TeammatePosition;
  row: MemberRow;
  here: { latitude: number; longitude: number } | null;
  onNavigate: (latitude: number, longitude: number) => void;
  onClose: () => void;
}) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const units = useSettingsStore((s) => s.units);
  const router = useRouter();
  const view = useTeamStore((s) => s.view);
  const status = useTeamStore((s) => s.statuses.get(member.id));
  const rb = here ? rangeAndBearing(here, member) : null;
  const age = shortAge(member.ageMs);
  const fresh =
    member.band === 'fresh'
      ? age === 'now'
        ? 'Live · updated now'
        : `Live · updated ${age} ago`
      : member.band === 'stale'
        ? `Last seen ${age} ago`
        : `Lost · ${age} ago`;
  const iAmGuest = view?.members.find((m) => m.isMe)?.role === 'guest';
  return (
    <View
      style={[styles.card, { backgroundColor: t.surface, shadowColor: palette.shadow }]}
      testID="team-card"
    >
      <View style={styles.head}>
        <BandAvatar
          initials={row.initials}
          color={row.color}
          band={member.band}
          size={48}
          ring={t.surface}
          live
        />
        <View style={styles.flex}>
          <View style={styles.nameRow}>
            <Text style={[styles.name, { color: t.ink }]} numberOfLines={1}>
              {member.name}
            </Text>
            {status && (
              <View style={[styles.schip, { backgroundColor: t.surfaceVariant }]}>
                <Text
                  style={[
                    styles.schipText,
                    {
                      color:
                        status.id === 'ok'
                          ? t.status.gnssFixed
                          : status.id === 'help'
                            ? t.status.gpsLostInk
                            : t.status.pausedInk,
                    },
                  ]}
                >
                  {STATUS_LABEL[status.id]}
                </Text>
              </View>
            )}
          </View>
          <Text
            style={[
              styles.sub,
              { color: member.band === 'fresh' ? t.inkMuted : t.status.pausedInk },
            ]}
            numberOfLines={1}
            testID="team-card-fresh"
          >
            {member.accuracy !== null
              ? `${fresh} · ${formatAccuracy(member.accuracy, units)}`
              : fresh}
          </Text>
        </View>
        <IconButton icon="close" size={22} onPress={onClose} accessibilityLabel="Close" />
      </View>

      <View style={[styles.facts, { borderColor: t.outlineVariant }]} testID="team-card-range">
        <Fact label="Distance" value={rb ? distanceText(rb.meters, units) : '—'} />
        <Fact
          label="Bearing"
          value={rb ? `${Math.round((rb.bearingDeg + 360) % 360)}° ${rb.compass}` : '—'}
          divider
        />
        <Fact label="Last fix" value={age} divider />
      </View>

      <View style={styles.acts}>
        <Act
          icon="message-text-outline"
          label="Message"
          testID="team-member-message"
          onPress={() => {
            onClose();
            router.push('/team/chat');
          }}
        />
        <Act
          icon="navigation-variant"
          label="Navigate to"
          primary
          testID="team-member-goto"
          onPress={() => {
            onNavigate(member.lat, member.lon);
            onClose();
          }}
        />
        <Act
          icon="image-filter-center-focus"
          label="Centre"
          testID="team-member-centre"
          onPress={() => {
            useTeamMapFocus.getState().focus(member.lon, member.lat, 16);
            onClose();
          }}
        />
      </View>
      <View style={styles.secondary}>
        {row.role !== 'guest' && !iAmGuest && (
          <Pressable
            onPress={() => {
              onClose();
              router.push(`/team/task-new?to=${member.id}` as never);
            }}
            style={styles.link}
            accessibilityRole="button"
            testID="team-member-task"
            hitSlop={8}
          >
            <Icon source="checkbox-marked-circle-plus-outline" size={18} color={t.inkVariant} />
            <Text style={[styles.linkText, { color: t.inkVariant }]}>Task</Text>
          </Pressable>
        )}
        <Pressable
          onPress={() => {
            const session = teamService()?.active;
            if (view) {
              session?.sendMessage(`@${member.name} where are you?`, {
                mentions: [member.id],
                aud: { m: [member.id, view.me] },
              });
            }
            useTeamStore.getState().refresh();
            onClose();
          }}
          style={styles.link}
          accessibilityRole="button"
          testID="team-member-where"
          hitSlop={8}
        >
          <Icon source="map-marker-question-outline" size={18} color={t.inkVariant} />
          <Text style={[styles.linkText, { color: t.inkVariant }]}>Where are you?</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Fact({ label, value, divider }: { label: string; value: string; divider?: boolean }) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  return (
    <View
      style={[styles.fact, divider && { borderLeftWidth: 1, borderLeftColor: t.outlineVariant }]}
      accessible
      accessibilityLabel={`${label}: ${value}`}
    >
      <Text style={[styles.factLabel, { color: t.inkMuted }]}>{label}</Text>
      <Text style={[styles.factValue, { color: t.ink }]}>{value}</Text>
    </View>
  );
}

function Act({
  icon,
  label,
  onPress,
  testID,
  primary = false,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  testID: string;
  primary?: boolean;
}) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const bg = primary ? t.support.accent : t.surfaceVariant;
  const ink = primary ? t.support.onAccent : t.ink;
  return (
    <Pressable
      onPress={onPress}
      style={[styles.act, { backgroundColor: bg }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
    >
      <Icon source={icon} size={22} color={ink} />
      <Text style={[styles.actText, { color: ink }]}>{label}</Text>
    </Pressable>
  );
}

const stylesSheet = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  card: {
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    shadowOpacity: 0.3,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontSize: 20, lineHeight: 25, fontWeight: '800', flexShrink: 1 },
  sub: { fontSize: 13.5, marginTop: 2 },
  schip: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 1 },
  schipText: { fontSize: 11, fontWeight: '800' },
  facts: { flexDirection: 'row', marginVertical: 12, borderWidth: 1, borderRadius: 16 },
  fact: { flex: 1, paddingHorizontal: 12, paddingVertical: 8 },
  factLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.7, textTransform: 'uppercase' },
  factValue: { fontSize: 16, fontWeight: '800' },
  acts: { flexDirection: 'row', gap: 8 },
  act: {
    flex: 1,
    height: 60,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  actText: { fontSize: 13, fontWeight: '800' },
  secondary: { flexDirection: 'row', justifyContent: 'center', gap: 24, paddingTop: 10 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 },
  linkText: { fontSize: 14, fontWeight: '700' },
});
