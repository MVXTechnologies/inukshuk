/**
 * One member (#589): who they are, their role and group, how their phone is
 * syncing, and — for admins, exactly as the core allows — promote, demote,
 * group and remove. Removing rotates the team key at once (removal fails
 * closed: nobody can write until it rotates).
 */
import { rangeAndBearing, shortAge } from '@core/teamui/positions';
import type { Role } from '@core/team/roles';
import { teamService, useTeamStore } from '@state/teamStore';
import { useSettingsStore } from '@state/settingsStore';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { Button, Switch, Text } from 'react-native-paper';

import {
  ChoiceRow,
  MemberAvatar,
  Note,
  ROLE_LABEL,
  RoleChip,
  SectionLabel,
  TeamScreenFrame,
  useNow,
} from './components';
import { actionMessage } from './messages';
import { memberSyncLine } from './syncLine';

const VIA: Record<string, string> = {
  genesis: 'Started the team',
  add: 'Added by an admin',
  admit: 'Joined with an invite',
};

export function MemberScreen() {
  const t = useSchemeTokens();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const now = useNow(15_000);
  const view = useTeamStore((s) => s.view);
  const peers = useTeamStore((s) => s.peers);
  const positions = useTeamStore((s) => s.positions);
  const here = useSettingsStore((s) => s.lastKnownPosition);
  const m = view?.members.find((x) => x.id === id);
  const [group, setGroup] = useState<string>(m?.groups[0]?.id ?? 'none');
  const [lead, setLead] = useState<boolean>(m?.groups[0]?.lead ?? false);
  if (view === null || m === undefined) {
    return <TeamScreenFrame title="Member">{null}</TeamScreenFrame>;
  }
  const session = teamService()?.active;
  const run = (err: string | null | undefined) => {
    if (err) Alert.alert('Not done', actionMessage(err));
    useTeamStore.getState().refresh();
  };
  const pos = positions.find((p) => p.id === m.id);
  const rb = pos && here ? rangeAndBearing(here, pos) : null;

  const changeRole = (role: Role) =>
    Alert.alert(
      `${role === 'admin' ? 'Make' : 'Change'} ${m.name} ${ROLE_LABEL[role].toLowerCase()}?`,
      role === 'admin'
        ? 'Admins manage members, invites, groups and the team’s lifetime. In this version a demoted admin can’t be made admin again.'
        : role === 'guest'
          ? 'Guests can read, post messages and share their position, but not edit shared waypoints.'
          : undefined,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Change', onPress: () => run(session?.setRole(m.id, role)) },
      ],
    );

  const remove = () =>
    Alert.alert(
      `Remove ${m.name}?`,
      'Their phone stops syncing with the team and the team key is rotated, so they can’t read anything new. What they already received stays on their phone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            run(session?.removeMember(m.id));
            router.back();
          },
        },
      ],
    );

  return (
    <TeamScreenFrame title={m.isMe ? `${m.name} (you)` : m.name} testID="team-member-screen">
      <View style={styles.head}>
        <MemberAvatar initials={m.initials} color={m.color} size={56} dim={!m.active} />
        <View style={styles.flex}>
          <View style={styles.row}>
            <RoleChip role={m.role} left={m.left} />
          </View>
          <Text variant="bodySmall" style={{ color: t.inkVariant }}>
            {VIA[m.via] ?? ''} · {new Date(m.joinedAt).toLocaleDateString()}
          </Text>
          {!m.isMe && (
            <Text variant="bodySmall" style={{ color: t.inkVariant }}>
              {m.active ? memberSyncLine(m.id, peers, m.lastSeenAt, now) : 'Removed'}
            </Text>
          )}
        </View>
      </View>

      {pos && (
        <Note icon="map-marker-account-outline">
          {`Position ${shortAge(pos.ageMs) === 'now' ? 'just now' : `${shortAge(pos.ageMs)} ago`}${
            rb
              ? ` · ${rb.meters < 1000 ? `${Math.round(rb.meters)} m` : `${(rb.meters / 1000).toFixed(1)} km`} ${rb.compass} of you`
              : ''
          }${pos.accuracy !== null ? ` · ±${Math.round(pos.accuracy)} m` : ''}`}
        </Note>
      )}
      {m.groups.length > 0 && (
        <Text variant="bodyMedium" style={{ color: t.ink }}>
          {m.groups.map((g) => (g.lead ? `${g.name} (lead)` : g.name)).join(', ')}
        </Text>
      )}

      {m.active && (m.actions.promote || m.actions.demote || m.actions.remove) && (
        <>
          <SectionLabel>Manage</SectionLabel>
          {m.actions.promote && (
            <Button
              mode="outlined"
              icon="arrow-up"
              onPress={() => changeRole(m.actions.promote!)}
              testID="team-member-promote"
            >
              {`Make ${ROLE_LABEL[m.actions.promote].toLowerCase()}`}
            </Button>
          )}
          {m.actions.demote && (
            <Button
              mode="outlined"
              icon="arrow-down"
              onPress={() => changeRole(m.actions.demote!)}
              testID="team-member-demote"
            >
              {`Make ${ROLE_LABEL[m.actions.demote].toLowerCase()}`}
            </Button>
          )}
          {m.actions.setGroup && (
            <View style={[styles.card, { backgroundColor: t.surfaceVariant }]}>
              <Text variant="titleSmall" style={{ color: t.ink }}>
                Group
              </Text>
              <ChoiceRow
                options={[
                  { id: 'none', label: 'None' },
                  ...view.groups.map((g) => ({ id: g.id, label: g.name })),
                ]}
                value={group}
                onChange={setGroup}
              />
              {group !== 'none' && (
                <View style={styles.row}>
                  <Text variant="bodyMedium" style={[styles.flex, { color: t.ink }]}>
                    Group lead
                  </Text>
                  <Switch value={lead} onValueChange={setLead} accessibilityLabel="Group lead" />
                </View>
              )}
              <Button
                mode="contained-tonal"
                onPress={() =>
                  run(session?.setMemberGroup(m.id, group === 'none' ? null : group, lead))
                }
              >
                Save group
              </Button>
            </View>
          )}
          {m.actions.remove && (
            <Button
              mode="text"
              textColor={t.status.gpsLostInk}
              onPress={remove}
              style={styles.left}
              testID="team-member-remove"
            >
              Remove from team
            </Button>
          )}
        </>
      )}
    </TeamScreenFrame>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  card: { borderRadius: 12, padding: 12, gap: space.sm },
  left: { alignSelf: 'flex-start' },
});
