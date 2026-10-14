/**
 * The team panel (#707, mockup "Tap the pill"): it drops from the pill and
 * is the team's home on the map.
 *
 * - Actions: Chat (unread), Rally here, Draw, and my status (primary).
 * - Members, live first and nearest first (`panelMembers`); each row opens
 *   that teammate's card on the map (Message, Navigate to, Centre), or their
 *   page when their position is unknown.
 * - From the old team button's menu, at the bottom: Tasks, Rally at a
 *   point…, Manage team. SOS is deliberately not here: only the hold button
 *   sends it.
 *
 * A plain themed View over a scrim (no Paper Portal: paper-portal-touch-swallow);
 * Back and a tap on the scrim close it.
 */
import { STATUS_LABEL } from '@core/teamui/system';
import { distanceText, panelMembers } from '@core/teamui/teamBar';
import { MAP_OVERLAY_Z } from '@features/map/overlayOrder';
import { useSettingsStore } from '@state/settingsStore';
import { useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { enterDrawing } from '../draw/TeamDrawMode';
import { useTeamMapFocus } from '../map/teamMapFocus';
import { useTeamMapSelection } from '../map/TeamMapOverlay';
import { useTeamSheet } from '../map/teamMode';
import { useTeamPick } from '../map/TeamPick';
import { openPeers, teamSyncLine } from '../syncLine';
import { BandAvatar, FaceStack, myPosition } from './parts';
import { usePendingAlert } from './pendingAlert';
import { useTeamBarSummary } from './TeamStatusBar';

export function TeamPanel({
  top,
  here,
  focused = true,
}: {
  top: number;
  here: { latitude: number; longitude: number } | null;
  /** The map screen is in front: Back closes the panel only then. */
  focused?: boolean;
}) {
  const t = useSchemeTokens();
  const units = useSettingsStore((s) => s.units);
  const router = useRouter();
  const close = useTeamSheet((s) => s.close);
  const openSheet = useTeamSheet((s) => s.open);
  const summary = useTeamBarSummary();
  const view = useTeamStore((s) => s.view);
  const positions = useTeamStore((s) => s.positions);
  const peers = useTeamStore((s) => s.peers);
  const meshRunning = useTeamStore((s) => s.meshRunning);
  const statuses = useTeamStore((s) => s.statuses);
  const unread = useTeamStore((s) => s.unread + s.threadsUnread);
  const me = view?.me;
  const myOpenTasks = useTeamStore(
    (s) => s.tasks.filter((x) => !x.done && x.assignee === me).length,
  );
  useEffect(() => {
    if (!focused) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [focused, close]);
  const [opened] = useState(() => Date.now());
  const rows = useMemo(() => {
    if (view === null) return [];
    const connected = new Set(
      openPeers(peers)
        .map((p) => p.memberId)
        .filter((m): m is string => m !== null),
    );
    return panelMembers(view.members, positions, connected, here, opened);
  }, [view, positions, peers, here, opened]);
  if (view === null || summary === null) return null;
  const guest = view.members.find((m) => m.isMe)?.role === 'guest';
  const myStatus = me ? statuses.get(me)?.id : undefined;
  const go = (href: string) => () => {
    close();
    router.push(href as never);
  };
  const rallyHere = async () => {
    close();
    const at = await myPosition(here);
    if (at !== null) usePendingAlert.getState().start('rally', at);
    else usePendingAlert.setState({ error: 'Your position is unknown: no rally point was set.' });
  };
  const openMember = (id: string) => {
    close();
    const pos = positions.find((p) => p.id === id);
    if (pos) {
      useTeamMapSelection.getState().select({ kind: 'member', id });
      useTeamMapFocus.getState().focus(pos.lon, pos.lat, 16);
    } else router.push(`/team/member/${id}` as never);
  };

  const actions: [string, string, () => void, string, number?][] = [
    ['forum-outline', 'Chat', go('/team/chat'), 'team-panel-chat', unread],
    ...(guest
      ? []
      : ([
          ['flag-variant', 'Rally here', () => void rallyHere(), 'team-panel-rally'],
          [
            'draw',
            'Draw',
            () => {
              close();
              void enterDrawing();
            },
            'team-panel-draw',
          ],
        ] as [string, string, () => void, string][])),
  ];

  return (
    // One elevation-free layer at the map's overlay order (as the 2.6.0 team
    // button's, QA 09b): the panel's own elevation stays inside it, so Android
    // stacks the whole panel by MAP_OVERLAY_Z, not by its shadow.
    <View
      style={[StyleSheet.absoluteFill, { zIndex: MAP_OVERLAY_Z.teamPanel }]}
      pointerEvents="box-none"
      testID="team-panel-layer"
    >
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: t.team.menuScrim }]}
        onPress={close}
        accessibilityLabel="Close the team panel"
        testID="team-panel-scrim"
      />
      <View
        style={[
          styles.panel,
          {
            top,
            backgroundColor: t.surface,
            borderColor: t.outlineVariant,
            shadowColor: palette.shadow,
          },
        ]}
        testID="team-panel"
      >
        <View style={styles.head}>
          {summary.solo ? null : <FaceStack faces={summary.faces} size={26} ring={t.surface} />}
          <View style={styles.flex}>
            <Text style={[styles.title, { color: t.ink }]} numberOfLines={1}>
              {summary.name}
            </Text>
            <View style={styles.syncRow}>
              <Icon
                source={summary.sync === 'off' ? 'access-point-off' : 'access-point'}
                size={15}
                color={summary.sync === 'lan' ? t.status.gnssFixed : t.inkMuted}
              />
              <Text style={[styles.sync, { color: t.inkMuted }]} numberOfLines={1}>
                {summary.sync === 'lan'
                  ? `Nearby · ${teamSyncLine(peers, meshRunning)}`
                  : summary.status === 'Only you'
                    ? `Only you · ${teamSyncLine(peers, meshRunning)}`
                    : summary.sync === 'off'
                      ? summary.status
                      : teamSyncLine(peers, meshRunning)}
              </Text>
            </View>
          </View>
          <Pressable
            onPress={close}
            style={styles.x}
            accessibilityRole="button"
            accessibilityLabel="Close the team panel"
            testID="team-panel-close"
          >
            <Icon source="chevron-up" size={24} color={t.inkMuted} />
          </Pressable>
        </View>

        <View style={[styles.acts, { borderBottomColor: t.outlineVariant }]}>
          {actions.map(([icon, label, run, id, count]) => (
            <Act key={id} icon={icon} label={label} onPress={run} testID={id} count={count} />
          ))}
          <Act
            icon="check-circle"
            label={myStatus ? `Status · ${STATUS_LABEL[myStatus]}` : 'My status'}
            onPress={() => openSheet({ kind: 'status' })}
            testID="team-panel-status"
            primary
          />
        </View>

        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {summary.solo ? (
            <Row
              icon="account-plus"
              label="Invite people"
              onPress={go('/team/invite')}
              testID="team-panel-invite"
            />
          ) : (
            <>
              <View style={styles.sec}>
                <Text style={[styles.secText, { color: t.inkMuted }]}>
                  {`Members · ${summary.online} of ${summary.total} online`}
                </Text>
                <Text style={[styles.secHint, { color: t.inkVariant }]}>Tap for their card</Text>
              </View>
              {rows.map((m) => {
                const status = statuses.get(m.id);
                return (
                  <Pressable
                    key={m.id}
                    onPress={() => openMember(m.id)}
                    style={({ pressed }) => [
                      styles.member,
                      pressed && { backgroundColor: t.surfaceVariant },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={[
                      m.name,
                      status ? STATUS_LABEL[status.id] : null,
                      m.line,
                      m.distanceM !== null
                        ? `${distanceText(m.distanceM, units)} ${m.compass}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                    accessibilityHint="Opens their card"
                    testID={`team-panel-member-${m.name}`}
                  >
                    <BandAvatar
                      initials={m.initials}
                      color={m.color}
                      band={m.band}
                      size={36}
                      ring={t.surface}
                      live
                    />
                    <View style={[styles.flex, m.band !== 'fresh' && styles.dim]}>
                      <View style={styles.nameRow}>
                        <Text
                          style={[styles.memberName, { color: t.ink }]}
                          numberOfLines={1}
                          ellipsizeMode="tail"
                        >
                          {m.name}
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
                          styles.line,
                          { color: m.band === 'fresh' ? t.inkMuted : t.status.pausedInk },
                        ]}
                        numberOfLines={1}
                      >
                        {m.line}
                      </Text>
                    </View>
                    {m.distanceM !== null && (
                      <View style={[styles.right, m.band !== 'fresh' && styles.dim]}>
                        <Text style={[styles.dist, { color: t.ink }]}>
                          {`${distanceText(m.distanceM, units)} ${m.compass}`}
                        </Text>
                        {m.lastPosition && (
                          <Text style={[styles.lastPos, { color: t.inkMuted }]}>last position</Text>
                        )}
                      </View>
                    )}
                    <Icon source="chevron-right" size={20} color={t.inkMuted} />
                  </Pressable>
                );
              })}
            </>
          )}
        </ScrollView>

        <Row
          icon="checkbox-marked-circle-outline"
          label="Tasks"
          chip={myOpenTasks > 0 ? `${myOpenTasks} open` : undefined}
          onPress={go('/team/tasks')}
          testID="team-panel-tasks"
        />
        {!guest && (
          <Row
            icon="map-marker-plus-outline"
            label="Rally at a point…"
            onPress={() => {
              close();
              useTeamPick.getState().start('rally');
            }}
            testID="team-panel-rally-point"
          />
        )}
        <Row
          icon="account-cog-outline"
          label="Manage team"
          onPress={go('/team')}
          testID="team-panel-manage"
        />
      </View>
    </View>
  );
}

function Act({
  icon,
  label,
  onPress,
  testID,
  count = 0,
  primary = false,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  testID: string;
  count?: number;
  primary?: boolean;
}) {
  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      style={styles.act}
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `${label}, ${count} unread` : label}
      testID={testID}
    >
      <View
        style={[styles.actIcon, { backgroundColor: primary ? t.support.accent : t.surfaceVariant }]}
      >
        <Icon source={icon} size={24} color={primary ? t.support.onAccent : t.ink} />
        {count > 0 && (
          <View
            style={[styles.badge, { backgroundColor: t.team.bubbleNew, borderColor: t.surface }]}
          >
            <Text style={[styles.badgeText, { color: t.team.bubbleNewInk }]}>
              {count > 9 ? '9+' : count}
            </Text>
          </View>
        )}
      </View>
      <Text style={[styles.actLabel, { color: t.inkVariant }]} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

function Row({
  icon,
  label,
  chip,
  onPress,
  testID,
}: {
  icon: string;
  label: string;
  chip?: string;
  onPress: () => void;
  testID: string;
}) {
  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      style={[styles.foot, { borderTopColor: t.outlineVariant }]}
      accessibilityRole="button"
      accessibilityLabel={chip ? `${label}, ${chip}` : label}
      testID={testID}
    >
      <Icon source={icon} size={22} color={t.inkVariant} />
      <Text style={[styles.footLabel, styles.flex, { color: t.ink }]}>{label}</Text>
      {chip && (
        <View style={[styles.schip, { backgroundColor: t.surfaceVariant }]}>
          <Text style={[styles.schipText, { color: t.inkVariant }]}>{chip}</Text>
        </View>
      )}
      <Icon source="chevron-right" size={22} color={t.inkMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  dim: { opacity: 0.62 },
  panel: {
    position: 'absolute',
    left: 12,
    right: 12,
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    shadowOpacity: 0.34,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 14,
    paddingRight: 6,
    paddingTop: 10,
    paddingBottom: 8,
  },
  title: { fontSize: 18, lineHeight: 22, fontWeight: '800' },
  syncRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  sync: { fontSize: 12.5 },
  x: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  acts: {
    flexDirection: 'row',
    paddingHorizontal: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  act: { flex: 1, alignItems: 'center', gap: 5 },
  actIcon: {
    width: 52,
    height: 52,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actLabel: { fontSize: 12, lineHeight: 14, fontWeight: '700', textAlign: 'center' },
  badge: {
    position: 'absolute',
    top: -5,
    right: -6,
    minWidth: 19,
    height: 19,
    borderRadius: 10,
    borderWidth: 2,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 10.5, fontWeight: '900' },
  list: { maxHeight: 330 },
  listContent: { paddingBottom: 4 },
  sec: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
  },
  secText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  secHint: { fontSize: 11, lineHeight: 14, fontWeight: '700' },
  member: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 54,
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  memberName: { fontSize: 15, lineHeight: 19, fontWeight: '700', flexShrink: 1 },
  line: { fontSize: 12.5, lineHeight: 16 },
  right: { alignItems: 'flex-end' },
  dist: { fontSize: 13.5, fontWeight: '800' },
  lastPos: { fontSize: 11.5, fontWeight: '700' },
  schip: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 1 },
  schipText: { fontSize: 11, fontWeight: '800' },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 14,
    borderTopWidth: 1,
  },
  footLabel: { fontSize: 15, fontWeight: '700' },
});
