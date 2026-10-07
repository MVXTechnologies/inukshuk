/**
 * The team (#589, mockups `team-create` / `team-sync`): who's in it and how
 * each phone is syncing, my position sharing, invites, chat, shares, and the
 * team's lifetime. Warnings sit on top: Local Network denied (iOS), a key
 * rotation advised or required, the team ended, someone joining right now.
 */
import { MESH_DEFAULT_PORT, hotspotCandidates, isPrivateIPv4, parseIPv4 } from '@core/mesh/hotspot';
import { expiryLine, EXTEND_PRESETS } from '@core/teamui/lifetime';
import { parseHostPort } from '@core/teamui/invites';
import { MESH_LOOPBACK } from '@data/team';
import { reportError } from '@lib/errorReporting';
import { teamService, useTeamStore } from '@state/teamStore';
import { HeaderAction } from '@ui/components/ScreenHeader';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, View } from 'react-native';
import { Badge, Button, Icon, List, Switch, Text, TextInput } from 'react-native-paper';

import {
  ActionBanner,
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
import { SimulatedTeammates } from './SimulatedTeammates';
import { memberSyncLine, openPeers, teamSyncLine } from './syncLine';

const SHARE_INTERVALS = [
  { id: 30, label: '30 s' },
  { id: 60, label: '1 min' },
  { id: 300, label: '5 min' },
] as const;

/** A join's safety code stays up this long on the admitting phone. */
const JOIN_NOTICE_MS = 3 * 60_000;

export function TeamHubScreen() {
  const t = useSchemeTokens();
  const router = useRouter();
  const now = useNow(15_000);
  const loaded = useTeamStore((s) => s.loaded);
  const view = useTeamStore((s) => s.view);
  const record = useTeamStore((s) => s.record);
  const peers = useTeamStore((s) => s.peers);
  const mesh = useTeamStore((s) => s.mesh);
  const meshRunning = useTeamStore((s) => s.meshRunning);
  const unread = useTeamStore((s) => s.unread);
  const shares = useTeamStore((s) => s.shares);
  const notices = useTeamStore((s) => s.joinNotices);
  const [address, setAddress] = useState('');
  const [showDial, setShowDial] = useState(false);

  const session = teamService()?.active ?? null;

  if (!loaded || view === null || record === null || session === null) {
    return (
      <TeamScreenFrame title="Team" testID="team-hub-screen">
        <Text style={{ color: t.inkVariant }}>No team open.</Text>
        <Button mode="contained" onPress={() => router.replace('/team/create')}>
          Create a team
        </Button>
        <Button mode="outlined" onPress={() => router.replace('/team/join')}>
          Join a team
        </Button>
      </TeamScreenFrame>
    );
  }

  const run = (err: string | null, done?: string) => {
    if (err !== null) Alert.alert('Not done', actionMessage(err));
    else if (done) Alert.alert(done);
    useTeamStore.getState().refresh();
  };

  const prefs = record.prefs;
  const setPrefs = (patch: Partial<typeof prefs>) =>
    session.updateRecord({ prefs: { ...prefs, ...patch } });
  const connected = new Set(openPeers(peers).map((p) => p.memberId));
  const active = view.members.filter((m) => m.active);
  const recentJoins = notices.filter((n) => now - n.at < JOIN_NOTICE_MS);
  const leavers = active.filter((m) => m.left && m.actions.remove);
  const denied = mesh?.localNetwork === 'denied';

  const leave = () =>
    Alert.alert(
      `Leave “${view.name}”?`,
      view.myRole === 'owner'
        ? 'You organize this team: it keeps going without you (nobody can take over organizing it in this version). Its data is deleted from this phone; what teammates already have stays on their phones.'
        : 'The team is deleted from this phone and the admins are told, so they can remove you. What teammates already have stays on their phones.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: () =>
            void teamService()
              ?.leave(view.teamId)
              .then(() => router.back())
              .catch((e) => reportError(e, 'team-leave')),
        },
      ],
    );

  const endTeam = () =>
    Alert.alert(
      'End the team for everyone?',
      'Nobody can post, share or join any more; the team turns read-only on every phone. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'End team', style: 'destructive', onPress: () => run(session.closeTeam()) },
      ],
    );

  const dial = (host: string, port: number) => {
    if (!session.dial(host, port)) Alert.alert('Not connected', 'Team sync is off right now.');
    setShowDial(false);
  };

  return (
    <TeamScreenFrame title={view.name} testID="team-hub-screen">
      <View style={styles.headerRow}>
        <Text variant="bodyMedium" style={[styles.flex, { color: t.inkVariant }]}>
          {expiryLine(view.expiresAt, now, view.closed)} · {teamSyncLine(peers, meshRunning)}
        </Text>
        <View>
          <HeaderAction
            icon="message-text-outline"
            onPress={() => router.push('/team/chat')}
            accessibilityLabel="Team chat"
          />
          {unread > 0 && (
            <Badge style={styles.badge} testID="team-unread-badge">
              {unread}
            </Badge>
          )}
        </View>
      </View>

      {denied && (
        <ActionBanner
          icon="wifi-off"
          title="Local Network is off for Inukshuk"
          body="Teammates’ phones can’t be found or reached. Turn it on in Settings › Privacy & Security › Local Network."
          action="Settings"
          onAction={() => void Linking.openSettings()}
          testID="team-local-network-denied"
        />
      )}
      {mesh?.error && !denied && (
        <Note icon="alert-circle-outline" tone="warn">
          {`Team sync: ${mesh.error.message}`}
        </Note>
      )}
      {(view.readOnly || view.closed) && (
        <ActionBanner
          icon="lock-outline"
          title={view.closed ? 'This team was ended' : 'This team has ended'}
          body="It’s read-only: you can still look at everything."
          {...(view.isAdmin && !view.closed
            ? { action: '+7 days', onAction: () => run(session.extend(7)) }
            : {})}
          testID="team-ended-banner"
        />
      )}
      {view.needsRotation && !view.readOnly && (
        <ActionBanner
          icon="key-alert-outline"
          title="The team key must be rotated"
          body={
            view.isAdmin
              ? 'Someone was removed. Nobody can post until an admin rotates the key.'
              : 'Someone was removed. Posting resumes once an admin rotates the key.'
          }
          {...(view.isAdmin
            ? { action: 'Rotate now', onAction: () => run(session.rotateKey()) }
            : {})}
          testID="team-needs-rotation"
        />
      )}
      {view.rotationAdvised && !view.needsRotation && !view.readOnly && (
        <ActionBanner
          icon="key-change"
          title="Rotate the team key"
          body="An invite was used by two phones at once. The extra phone can read new messages until the key changes."
          {...(view.isAdmin
            ? { action: 'Rotate now', onAction: () => run(session.rotateKey()) }
            : {})}
          testID="team-rotation-advised"
        />
      )}
      {recentJoins.map((n) => {
        const who = n.memberId ? view.members.find((m) => m.id === n.memberId) : undefined;
        return (
          <Note key={n.peerId} icon="account-check-outline" testID="team-join-notice">
            <Text variant="bodySmall" style={{ color: t.ink }}>
              {who
                ? `${who.name} joined through this phone.`
                : 'Someone is joining through this phone.'}{' '}
              Check their screen shows{' '}
              <Text style={styles.code} testID="team-join-notice-code">
                {n.code.slice(0, 3)} {n.code.slice(3)}
              </Text>
              . If it doesn’t, remove them.
            </Text>
          </Note>
        );
      })}
      {leavers.map((m) => (
        <ActionBanner
          key={m.id}
          icon="account-arrow-right-outline"
          title={`${m.name} left the team`}
          body="Remove them so the key rotates."
          action="Remove"
          onAction={() => run(session.removeMember(m.id))}
        />
      ))}

      <View style={styles.actions}>
        {view.isAdmin && !view.readOnly && (
          <Button
            mode="contained"
            icon="account-plus-outline"
            onPress={() => router.push('/team/invite')}
            style={styles.flex}
            testID="team-invite-button"
          >
            Invite
          </Button>
        )}
        <Button
          mode="outlined"
          icon="message-text-outline"
          onPress={() => router.push('/team/chat')}
          style={styles.flex}
          testID="team-chat-button"
        >
          {unread > 0 ? `Chat · ${unread}` : 'Chat'}
        </Button>
      </View>

      <SectionLabel>My position</SectionLabel>
      <View style={[styles.card, { backgroundColor: t.surfaceVariant }]}>
        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text variant="titleSmall" style={{ color: t.ink }}>
              Share my position
            </Text>
            <Text variant="bodySmall" style={{ color: t.inkVariant }} testID="team-share-state">
              {prefs.sharePosition
                ? prefs.shareOnlyWhileRecording
                  ? 'On while you record · teammates see where you are'
                  : 'On while Inukshuk is open · teammates see where you are'
                : 'Off · nobody in the team sees where you are'}
            </Text>
          </View>
          <Switch
            value={prefs.sharePosition}
            onValueChange={(v) => setPrefs({ sharePosition: v })}
            accessibilityLabel="Share my position with the team"
            testID="team-share-switch"
            disabled={view.readOnly}
          />
        </View>
        {prefs.sharePosition && (
          <>
            <ChoiceRow
              options={SHARE_INTERVALS}
              value={
                (SHARE_INTERVALS.find((i) => i.id === prefs.shareIntervalS)?.id ?? 60) as
                  30 | 60 | 300
              }
              onChange={(v) => setPrefs({ shareIntervalS: v })}
              testIDPrefix="team-share-every"
            />
            <View style={styles.switchRow}>
              <Text variant="bodyMedium" style={[styles.flex, { color: t.ink }]}>
                Only while recording
              </Text>
              <Switch
                value={prefs.shareOnlyWhileRecording}
                onValueChange={(v) => setPrefs({ shareOnlyWhileRecording: v })}
                accessibilityLabel="Share only while recording"
              />
            </View>
          </>
        )}
      </View>

      <SectionLabel>{`Members · ${active.length}`}</SectionLabel>
      <View>
        {view.members.map((m) => (
          <Pressable
            key={m.id}
            onPress={() => router.push({ pathname: '/team/member/[id]', params: { id: m.id } })}
            style={[styles.member, !m.active && styles.faded]}
            accessibilityRole="button"
            accessibilityLabel={`${m.name}, ${m.active ? ROLE_LABEL[m.role] : 'Removed'}`}
            testID={`team-member-${m.isMe ? 'me' : m.name}`}
          >
            <MemberAvatar
              initials={m.initials}
              color={m.color}
              online={m.isMe || !m.active ? undefined : connected.has(m.id)}
              dim={!m.active}
            />
            <View style={styles.flex}>
              <Text variant="titleSmall" style={{ color: t.ink }} numberOfLines={1}>
                {m.isMe ? `${m.name} (you)` : m.name}
              </Text>
              <Text variant="bodySmall" style={{ color: t.inkVariant }} numberOfLines={1}>
                {!m.active
                  ? 'Removed'
                  : m.isMe
                    ? [
                        m.groups.map((g) => (g.lead ? `${g.name} lead` : g.name)).join(', '),
                        'this phone',
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : [
                        m.groups.map((g) => (g.lead ? `${g.name} lead` : g.name)).join(', '),
                        memberSyncLine(m.id, peers, m.lastSeenAt, now),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
              </Text>
            </View>
            {m.active && <RoleChip role={m.role} left={m.left} />}
          </Pressable>
        ))}
      </View>

      <List.Item
        title="Groups"
        description={
          view.groups.length === 0
            ? view.isAdmin
              ? 'None · group people to message a crew or its leads'
              : 'None'
            : view.groups.map((g) => g.name).join(', ')
        }
        descriptionNumberOfLines={2}
        left={(p) => <List.Icon {...p} icon="file-tree-outline" />}
        right={(p) => <List.Icon {...p} icon="chevron-right" />}
        onPress={() => router.push('/team/groups')}
        style={styles.listItem}
        testID="team-groups-row"
      />
      <List.Item
        title="Shared with the team"
        description={`${shares.waypoints.length} waypoint${shares.waypoints.length === 1 ? '' : 's'} · ${shares.tracks.length} trail${shares.tracks.length === 1 ? '' : 's'} · on the map`}
        left={(p) => <List.Icon {...p} icon="share-variant-outline" />}
        right={(p) => <List.Icon {...p} icon="chevron-right" />}
        onPress={() => router.push('/team/share')}
        style={styles.listItem}
        testID="team-shares-row"
      />

      <SectionLabel>Sync</SectionLabel>
      <Text variant="bodySmall" style={{ color: t.inkVariant }}>
        Every phone keeps a full copy and passes on what others missed. Phones find each other on
        the same Wi-Fi or a phone’s hotspot — no cell signal needed.
      </Text>
      {!showDial ? (
        <Button
          mode="text"
          icon="lan-connect"
          onPress={() => setShowDial(true)}
          style={styles.left}
          testID="team-dial-open"
          disabled={!meshRunning}
        >
          Connect by address (hotspot)
        </Button>
      ) : (
        <View style={[styles.card, { backgroundColor: t.surfaceVariant }]}>
          <Text variant="bodySmall" style={{ color: t.inkVariant }}>
            On a hotspot that hides phones from each other, type the address shown on the other
            phone’s team screen, or try the hotspot itself:
          </Text>
          <View style={styles.chips}>
            {hotspotCandidatesSafe().map((c) => (
              <Button key={c.host} mode="outlined" compact onPress={() => dial(c.host, c.port)}>
                {c.host}
              </Button>
            ))}
          </View>
          <TextInput
            returnKeyType="done"
            mode="outlined"
            dense
            label="Address (e.g. 172.20.10.1)"
            value={address}
            onChangeText={setAddress}
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            testID="team-dial-address"
          />
          <Button
            mode="contained"
            onPress={() => {
              const hp = parseHostPort(address, MESH_DEFAULT_PORT);
              if (hp === null) Alert.alert('Check the address', 'Four numbers like 192.168.1.20');
              else dial(hp.host, hp.port);
            }}
          >
            Connect
          </Button>
        </View>
      )}
      {meshRunning && mesh?.port != null && (
        <Text variant="bodySmall" style={{ color: t.inkMuted }} testID="team-my-address">
          {myAddressLine(mesh.port)}
        </Text>
      )}

      <SectionLabel>Team</SectionLabel>
      {view.isAdmin && !view.closed && (
        <View style={styles.extendRow}>
          <Icon source="calendar-clock" size={18} color={t.inkVariant} />
          <Text variant="bodyMedium" style={[styles.flex, { color: t.ink }]}>
            Extend
          </Text>
          {EXTEND_PRESETS.map((p) => (
            <Button
              key={p.id}
              mode="outlined"
              compact
              onPress={() => run(session.extend(p.days), `Extended by ${p.days} days`)}
              testID={`team-extend-${p.id}`}
            >
              {p.label}
            </Button>
          ))}
        </View>
      )}
      <Button mode="text" textColor={t.status.gpsLostInk} onPress={leave} style={styles.left}>
        Leave team
      </Button>
      {view.isAdmin && !view.closed && (
        <Button mode="text" textColor={t.status.gpsLostInk} onPress={endTeam} style={styles.left}>
          End team for everyone
        </Button>
      )}
      <Note icon="shield-lock-outline">
        Nothing goes through an Inukshuk server. Messages, positions and shares are end-to-end
        encrypted; only members can read them. Someone removed keeps what they already received.
      </Note>
      {MESH_LOOPBACK && <SimulatedTeammates />}
    </TeamScreenFrame>
  );
}

/** The hotspot's likely addresses (gateway, each private subnet's .1), best first. */
function hotspotCandidatesSafe(): { host: string; port: number }[] {
  const info = teamService()?.networkInfo() ?? null;
  return info ? hotspotCandidates(info).slice(0, 3) : [];
}

/** "This phone: 192.168.1.20" — what a teammate types when discovery is blocked. */
function myAddressLine(port: number): string {
  const info = teamService()?.networkInfo() ?? null;
  const addr = info?.interfaces.find((i) => {
    const v = parseIPv4(i.address);
    return v !== null && isPrivateIPv4(v);
  })?.address;
  return addr ? `This phone: ${addr}${port === MESH_DEFAULT_PORT ? '' : `:${port}`}` : '';
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginTop: -space.sm },
  badge: { position: 'absolute', top: 4, right: 4 },
  code: { fontWeight: '800', letterSpacing: 2 },
  actions: { flexDirection: 'row', gap: space.sm },
  card: { borderRadius: 12, padding: 12, gap: space.sm },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  member: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 8 },
  faded: { opacity: 0.6 },
  listItem: { paddingHorizontal: 0, marginHorizontal: -8 },
  left: { alignSelf: 'flex-start' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  extendRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
});
