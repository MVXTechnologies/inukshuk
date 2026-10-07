/**
 * The compact team cards of signal mode (#589, mockups v2): the action
 * button's menu, my quick status, notify someone, a trail spot's actions and
 * the long-press menu. Compact by default (one row of big round targets,
 * thumb-reachable); plain themed Views (paper-surface-ios-flex-collapse).
 */
import { findMentions } from '@core/teamui/compose';
import { STATUS_IDS, STATUS_LABEL, type StatusId } from '@core/teamui/system';
import { teamService, useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Button, Icon, IconButton, Text } from 'react-native-paper';

import { MemberAvatar } from '../components';
import { actionMessage } from '../messages';
import { usePinDraft } from './TeamPinComposer';
import { useTeamSheet, type TeamSheet } from './teamMode';

const STATUS_ICON: Record<StatusId, string> = {
  ok: 'check-circle',
  arrived: 'flag-checkered',
  regroup: 'account-group',
  stop10: 'coffee',
  help: 'hand-back-left',
};
const STATUS_SHORT: Record<StatusId, string> = {
  ok: 'OK',
  arrived: 'Arrived',
  regroup: 'Regroup',
  stop10: '10 min',
  help: 'Help',
};

export function Round({
  icon,
  label,
  onPress,
  testID,
  tint,
  filled,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  testID?: string;
  tint?: string;
  filled?: boolean;
}) {
  const t = useSchemeTokens();
  const c = tint ?? t.ink;
  return (
    <Pressable
      onPress={onPress}
      style={styles.roundItem}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      hitSlop={4}
    >
      <View
        style={[
          styles.roundBtn,
          tint
            ? { borderWidth: 3, borderColor: c, backgroundColor: filled ? c : 'transparent' }
            : { backgroundColor: t.surfaceVariant },
        ]}
      >
        <Icon source={icon} size={26} color={filled ? palette.white : c} />
      </View>
      <Text variant="labelSmall" style={[styles.roundLabel, { color: t.ink }]} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

function Card({
  title,
  sub,
  icon,
  onClose,
  children,
  testID,
}: {
  title: string;
  sub?: string;
  icon?: string;
  onClose: () => void;
  children: React.ReactNode;
  testID?: string;
}) {
  const t = useSchemeTokens();
  return (
    <View
      style={[styles.card, { backgroundColor: t.elevation.level2, shadowColor: palette.shadow }]}
      testID={testID}
    >
      <View style={styles.head}>
        {icon ? <Icon source={icon} size={22} color={t.ink} /> : null}
        <View style={styles.flex}>
          <Text variant="titleSmall" style={{ color: t.ink }} numberOfLines={1}>
            {title}
          </Text>
          {sub ? (
            <Text variant="bodySmall" style={{ color: t.inkVariant }} numberOfLines={1}>
              {sub}
            </Text>
          ) : null}
        </View>
        <IconButton icon="close" size={20} onPress={onClose} accessibilityLabel="Close" />
      </View>
      {children}
    </View>
  );
}

function StatusCard({ onClose }: { onClose: () => void }) {
  const t = useSchemeTokens();
  const me = useTeamStore((s) => s.view?.me);
  const mine = useTeamStore((s) => (me ? s.statuses.get(me)?.id : undefined));
  const [error, setError] = useState<string | null>(null);
  const tint: Record<StatusId, string> = {
    ok: t.status.gnssFixed,
    arrived: t.ink,
    regroup: t.ink,
    stop10: t.ink,
    help: t.status.gpsLostInk,
  };
  return (
    <Card
      title="My status"
      sub="Seen by the team on the map"
      onClose={onClose}
      testID="team-status-card"
    >
      <View style={styles.roundRow}>
        {STATUS_IDS.map((id) => (
          <Round
            key={id}
            icon={STATUS_ICON[id]}
            label={STATUS_SHORT[id]}
            tint={tint[id]}
            filled={mine === id}
            testID={`team-status-${id}`}
            onPress={() => {
              const session = teamService()?.active;
              const err = session ? session.setMyStatus(id) : 'not-member';
              useTeamStore.getState().refresh();
              if (err) setError(actionMessage(err));
              else onClose();
            }}
          />
        ))}
      </View>
      {error !== null && (
        <Text variant="bodySmall" style={{ color: t.status.gpsLostInk }}>
          {error}
        </Text>
      )}
    </Card>
  );
}

const PHRASES = ['Come here', 'Look at this', 'Wait for me', 'Need help', 'We regroup here'];

function NotifyCard({ at, onClose }: { at: [number, number] | null; onClose: () => void }) {
  const t = useSchemeTokens();
  const view = useTeamStore((s) => s.view);
  const [who, setWho] = useState<string[]>([]);
  const [phrase, setPhrase] = useState(PHRASES[0]!);
  const [error, setError] = useState<string | null>(null);
  if (view === null) return null;
  const people = view.members.filter((m) => m.active && !m.isMe);
  const send = () => {
    const session = teamService()?.active;
    if (!session || who.length === 0) return;
    const names = people.filter((m) => who.includes(m.id)).map((m) => `@${m.name}`);
    const text = `${names.join(' ')} ${phrase}`;
    const mentions = findMentions(text, view.members);
    // At a place: a pin addressed to them (they get the alert and the spot);
    // else a message to just them.
    const err = at
      ? session.dropPin(at[0], at[1], text, mentions)
      : session.sendMessage(text, { mentions, aud: { m: [...who, view.me] } });
    useTeamStore.getState().refresh();
    if (err) setError(actionMessage(err));
    else onClose();
  };
  return (
    <Card
      title={at ? 'Notify · this spot' : 'Notify'}
      icon="bell-ring-outline"
      onClose={onClose}
      testID="team-notify-card"
    >
      <View style={styles.people}>
        {people.map((m) => {
          const on = who.includes(m.id);
          return (
            <Pressable
              key={m.id}
              onPress={() => setWho((w) => (on ? w.filter((x) => x !== m.id) : [...w, m.id]))}
              style={styles.person}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={m.name}
              testID={`team-notify-${m.name}`}
            >
              <View style={[styles.personRing, { borderColor: on ? t.ink : 'transparent' }]}>
                <MemberAvatar initials={m.initials} color={m.color} size={40} />
              </View>
              <Text variant="labelSmall" style={{ color: t.ink }} numberOfLines={1}>
                {m.name.split(' ')[0]}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.chips}>
        {PHRASES.map((p) => (
          <Pressable
            key={p}
            onPress={() => setPhrase(p)}
            style={[
              styles.chip,
              {
                borderColor: p === phrase ? t.ink : t.outlineVariant,
                backgroundColor: p === phrase ? t.surfaceVariant : 'transparent',
              },
            ]}
            accessibilityRole="radio"
            accessibilityState={{ selected: p === phrase }}
          >
            <Text variant="labelLarge" style={{ color: t.ink }}>
              {p}
            </Text>
          </Pressable>
        ))}
      </View>
      {error !== null && (
        <Text variant="bodySmall" style={{ color: t.status.gpsLostInk }}>
          {error}
        </Text>
      )}
      <Button
        mode="contained"
        icon="bell-ring-outline"
        disabled={who.length === 0}
        onPress={send}
        testID="team-notify-send"
      >
        {who.length === 0 ? 'Pick who' : `Notify ${who.length}`}
      </Button>
    </Card>
  );
}

/** A spot on a trail (team mode): the team's actions there, never the profile. */
function SpotCard({
  at,
  trail,
  onClose,
}: {
  at: [number, number];
  trail: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const open = useTeamSheet((s) => s.open);
  const guest = useTeamStore((s) => s.view?.members.find((m) => m.isMe)?.role === 'guest');
  return (
    <Card
      title={trail}
      sub="This spot on the trail"
      icon="map-marker-path"
      onClose={onClose}
      testID="team-spot-card"
    >
      <View style={styles.roundRow}>
        <Round
          icon="comment-text-outline"
          label="Comment"
          testID="team-spot-comment"
          onPress={() => {
            onClose();
            usePinDraft.getState().open(at[0], at[1]);
          }}
        />
        {!guest && (
          <Round
            icon="checkbox-marked-circle-plus-outline"
            label="Task"
            testID="team-spot-task"
            onPress={() => {
              onClose();
              router.push(`/team/task-new?ak=point&la=${at[1]}&lo=${at[0]}` as never);
            }}
          />
        )}
        <Round
          icon="bell-ring-outline"
          label="Notify"
          testID="team-spot-notify"
          onPress={() => open({ kind: 'notify', at })}
        />
        <Round
          icon="map-marker-plus-outline"
          label="Waypoint"
          testID="team-spot-waypoint"
          onPress={() => {
            onClose();
            const err = teamService()?.active?.shareWaypoint({
              latitude: at[1],
              longitude: at[0],
              label: 'Waypoint',
            });
            if (!err) useTeamStore.getState().refresh();
          }}
        />
      </View>
    </Card>
  );
}

/** Long-press in team mode: the team's actions here; Navigate/Coordinates/Convert below. */
function PressCard({
  at,
  onClose,
  onPointActions,
}: {
  at: [number, number];
  onClose: () => void;
  onPointActions: (at: [number, number], what: 'navigate' | 'coordinates' | 'convert') => void;
}) {
  const t = useSchemeTokens();
  const router = useRouter();
  const open = useTeamSheet((s) => s.open);
  const guest = useTeamStore((s) => s.view?.members.find((m) => m.isMe)?.role === 'guest');
  return (
    <Card
      title="Here"
      sub={`${at[1].toFixed(5)}, ${at[0].toFixed(5)}`}
      icon="crosshairs"
      onClose={onClose}
      testID="team-press-card"
    >
      <View style={styles.roundRow}>
        <Round
          icon="map-marker-account-outline"
          label="Message pin"
          testID="team-press-pin"
          onPress={() => {
            onClose();
            usePinDraft.getState().open(at[0], at[1]);
          }}
        />
        {!guest && (
          <Round
            icon="checkbox-marked-circle-plus-outline"
            label="Task"
            testID="team-press-task"
            onPress={() => {
              onClose();
              router.push(`/team/task-new?ak=point&la=${at[1]}&lo=${at[0]}` as never);
            }}
          />
        )}
        <Round
          icon="bell-ring-outline"
          label="Notify"
          testID="team-press-notify"
          onPress={() => open({ kind: 'notify', at })}
        />
        {!guest && (
          <Round
            icon="map-marker-plus-outline"
            label="Waypoint"
            testID="team-press-waypoint"
            onPress={() => {
              onClose();
              const err = teamService()?.active?.shareWaypoint({
                latitude: at[1],
                longitude: at[0],
                label: 'Waypoint',
              });
              if (!err) useTeamStore.getState().refresh();
            }}
          />
        )}
      </View>
      <View style={[styles.secondary, { borderTopColor: t.outlineVariant }]}>
        {(
          [
            ['navigate', 'Navigate here'],
            ['coordinates', 'Coordinates'],
            ['convert', 'Convert'],
          ] as const
        ).map(([what, label]) => (
          <Pressable
            key={what}
            onPress={() => {
              onClose();
              onPointActions(at, what);
            }}
            accessibilityRole="button"
            testID={`team-press-${what}`}
            hitSlop={8}
          >
            <Text variant="labelLarge" style={{ color: t.inkVariant }}>
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
    </Card>
  );
}

export function TeamSheetCard({
  sheet,
  onPointActions,
}: {
  sheet: TeamSheet;
  onPointActions: (at: [number, number], what: 'navigate' | 'coordinates' | 'convert') => void;
}) {
  const close = useTeamSheet((s) => s.close);
  switch (sheet.kind) {
    case 'status':
      return <StatusCard onClose={close} />;
    case 'notify':
      return <NotifyCard at={sheet.at} onClose={close} />;
    case 'spot':
      return <SpotCard at={sheet.at} trail={sheet.trail} onClose={close} />;
    case 'press':
      return <PressCard at={sheet.at} onClose={close} onPointActions={onPointActions} />;
    default:
      return null;
  }
}

/** The team action button (bottom right) and its menu. */
export function TeamFab({ bottom }: { bottom: number }) {
  const t = useSchemeTokens();
  const router = useRouter();
  const sheet = useTeamSheet((s) => s.sheet);
  const open = useTeamSheet((s) => s.open);
  const close = useTeamSheet((s) => s.close);
  const unread = useTeamStore((s) => s.unread);
  const me = useTeamStore((s) => s.view?.me);
  const myStatus = useTeamStore((s) => (me ? s.statuses.get(me)?.id : undefined));
  const guest = useTeamStore((s) => s.view?.members.find((m) => m.isMe)?.role === 'guest');
  const menuOpen = sheet?.kind === 'menu';
  const items: [string, string, () => void, string][] = [
    [
      'check-circle-outline',
      myStatus ? `My status · ${STATUS_LABEL[myStatus]}` : 'My status',
      () => open({ kind: 'status' }),
      'team-fab-status',
    ],
    [
      'bell-ring-outline',
      'Notify someone',
      () => open({ kind: 'notify', at: null }),
      'team-fab-notify',
    ],
    ...(guest
      ? []
      : ([
          [
            'checkbox-marked-circle-plus-outline',
            'New task',
            () => {
              close();
              router.push('/team/task-new' as never);
            },
            'team-fab-task',
          ],
        ] as [string, string, () => void, string][])),
    [
      'message-text-outline',
      unread > 0 ? `Team chat · ${unread}` : 'Team chat',
      () => {
        close();
        router.push('/team/chat');
      },
      'team-fab-chat',
    ],
    [
      'account-multiple',
      'Members & team',
      () => {
        close();
        router.push('/team');
      },
      'team-fab-members',
    ],
  ];
  return (
    <>
      {menuOpen && (
        <View style={[styles.menu, { bottom: bottom + 72 }]} pointerEvents="box-none">
          {items.map(([icon, label, run, id]) => (
            <Pressable
              key={id}
              onPress={run}
              style={styles.menuRow}
              accessibilityRole="button"
              accessibilityLabel={label}
              testID={id}
            >
              <View
                style={[
                  styles.menuLabel,
                  { backgroundColor: t.elevation.level2, shadowColor: palette.shadow },
                ]}
              >
                <Text variant="labelLarge" style={{ color: t.ink }}>
                  {label}
                </Text>
              </View>
              <View
                style={[
                  styles.menuBtn,
                  { backgroundColor: t.elevation.level2, shadowColor: palette.shadow },
                ]}
              >
                <Icon source={icon} size={24} color={t.ink} />
              </View>
            </Pressable>
          ))}
        </View>
      )}
      <Pressable
        onPress={() => (menuOpen ? close() : open({ kind: 'menu' }))}
        style={[styles.fab, { bottom, borderColor: t.team.bubbleNew, backgroundColor: t.ink }]}
        accessibilityRole="button"
        accessibilityLabel={
          menuOpen ? 'Close the team menu' : `Team actions${unread ? `, ${unread} unread` : ''}`
        }
        testID="team-fab"
      >
        <Icon source={menuOpen ? 'close' : 'account-group'} size={28} color={t.background} />
        {!menuOpen && unread > 0 && (
          <View
            style={[styles.badge, { backgroundColor: t.team.bubbleNew, borderColor: t.background }]}
          >
            <Text style={[styles.badgeText, { color: t.team.bubbleNewInk }]}>
              {unread > 9 ? '9+' : unread}
            </Text>
          </View>
        )}
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 12,
    gap: 8,
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 4 },
  roundRow: { flexDirection: 'row', justifyContent: 'space-around' },
  roundItem: { alignItems: 'center', gap: 4, width: 64 },
  roundBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundLabel: { textAlign: 'center' },
  people: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  person: { alignItems: 'center', width: 60, gap: 2 },
  personRing: { borderWidth: 3, borderRadius: 26, padding: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 40,
  },
  secondary: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 10,
  },
  fab: {
    position: 'absolute',
    right: 12,
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 8,
    elevation: 6,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: { fontSize: 11, fontWeight: '900' },
  menu: { position: 'absolute', right: 16, gap: 10, alignItems: 'flex-end', zIndex: 9 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  menuLabel: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 3,
  },
  menuBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
});
