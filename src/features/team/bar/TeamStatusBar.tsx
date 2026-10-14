/**
 * The team status bar (#707, design C): in team mode it takes the map's
 * search slot. The pill shows the three freshest faces, the team's name,
 * "4/6 online" and the sync glyph (or "Only you", "Offline · 12 min"); a tap
 * opens the team panel. Under it, the column: the active SOS / gather band
 * (#708) and the chips — Chat (unread), Rally here, Draw; a team of one
 * gets Invite and Draw. Guests get Chat only (they cannot rally or draw).
 *
 * The column's measured height is published (`useTeamBarLayout`) so the
 * map's top-centre chips (destination, marine notice, receiver) move below
 * it instead of colliding with it.
 */
import { teamBarSummary, type TeamBarSummary } from '@core/teamui/teamBar';
import { useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { create } from 'zustand';

import { enterDrawing } from '../draw/TeamDrawMode';
import { useTeamSheet } from '../map/teamMode';
import { openPeers } from '../syncLine';
import { AlertBands } from './AlertBands';
import { FaceStack, myPosition } from './parts';
import { usePendingAlert } from './pendingAlert';

/** The pill's height and the gap to the column under it. */
export const PILL_H = 48;
const COLUMN_GAP = 8;
const CLOCK_MS = 30_000;

/** How far below the pill's top the bar reaches (pill + column), for the chips under it. */
export const useTeamBarLayout = create<{ height: number; set: (h: number) => void }>((set) => ({
  height: 0,
  set: (height) => set({ height }),
}));

/** The bar's summary, from the store; re-read every 30 s for "Offline · N min". */
export function useTeamBarSummary(): TeamBarSummary | null {
  const view = useTeamStore((s) => s.view);
  const positions = useTeamStore((s) => s.positions);
  const peers = useTeamStore((s) => s.peers);
  const meshRunning = useTeamStore((s) => s.meshRunning);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(id);
  }, []);
  return useMemo(() => {
    if (view === null) return null;
    const connected = new Set(
      openPeers(peers)
        .map((p) => p.memberId)
        .filter((m): m is string => m !== null),
    );
    return teamBarSummary({
      name: view.name,
      members: view.members,
      positions,
      connected,
      meshRunning,
      now,
    });
  }, [view, positions, peers, meshRunning, now]);
}

export function TeamStatusBar({
  top,
  here,
  onNavigate,
}: {
  /** The pill's top (the search pill's). */
  top: number;
  here: { latitude: number; longitude: number } | null;
  onNavigate: (latitude: number, longitude: number) => void;
}) {
  const t = useSchemeTokens();
  const router = useRouter();
  const summary = useTeamBarSummary();
  const unread = useTeamStore((s) => s.unread + s.threadsUnread);
  const guest = useTeamStore((s) => s.view?.members.find((m) => m.isMe)?.role === 'guest');
  const panelOpen = useTeamSheet((s) => s.sheet?.kind === 'menu');
  const open = useTeamSheet((s) => s.open);
  const pendingRally = usePendingAlert((s) => s.pending?.kind === 'rally');
  const setHeight = useTeamBarLayout((s) => s.set);
  useEffect(() => () => setHeight(0), [setHeight]);
  if (summary === null) return null;

  const glyph = summary.sync === 'off' ? 'access-point-off' : 'access-point';
  const glyphColor =
    summary.sync === 'lan'
      ? t.map.gnssFixed
      : summary.sync === 'look'
        ? t.map.gnssWarn
        : t.map.gnssLost;
  const offline = summary.sync === 'off' && !summary.solo;

  const rallyHere = async () => {
    const at = await myPosition(here);
    if (at !== null) usePendingAlert.getState().start('rally', at);
    else usePendingAlert.setState({ error: 'Your position is unknown: no rally point was set.' });
  };

  const chips: ChipSpec[] = summary.solo
    ? [
        {
          id: 'invite',
          icon: 'account-plus',
          label: 'Invite',
          accent: true,
          onPress: () => router.push('/team/invite' as never),
        },
        ...(guest ? [] : [drawChip]),
      ]
    : [
        {
          id: 'chat',
          icon: 'forum-outline',
          label: 'Chat',
          count: unread,
          onPress: () => router.push('/team/chat' as never),
        },
        ...(guest
          ? []
          : [
              {
                id: 'rally',
                icon: 'flag-variant',
                label: 'Rally here',
                pending: pendingRally,
                onPress: () => void rallyHere(),
              },
              drawChip,
            ]),
      ];

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {!panelOpen && (
        <Pressable
          onPress={() => open({ kind: 'menu' })}
          style={[styles.pill, { top, backgroundColor: t.map.chrome, shadowColor: palette.shadow }]}
          accessibilityRole="button"
          accessibilityLabel={summary.a11y}
          testID="team-bar-pill"
        >
          {summary.solo ? (
            <View style={[styles.add, { backgroundColor: t.support.accent }]}>
              <Icon source="account-plus" size={17} color={t.support.onAccent} />
            </View>
          ) : (
            <FaceStack faces={summary.faces} size={24} ring={t.map.chrome} />
          )}
          <View style={styles.flex}>
            <Text style={[styles.name, { color: t.map.chromeInk }]} numberOfLines={1}>
              {summary.name}
            </Text>
            <View style={styles.statusRow}>
              {offline ? (
                <>
                  <Icon source={glyph} size={14} color={glyphColor} />
                  <Text
                    style={[styles.status, { color: t.map.gnssLost }]}
                    numberOfLines={1}
                    testID="team-bar-status"
                  >
                    {summary.status}
                  </Text>
                </>
              ) : (
                <>
                  <Text
                    style={[styles.status, styles.strong, { color: t.map.chromeInk }]}
                    numberOfLines={1}
                    testID="team-bar-status"
                  >
                    {summary.solo ? summary.status : `${summary.online}/${summary.total}`}
                  </Text>
                  {!summary.solo && (
                    <Text style={[styles.status, { color: t.map.chromeInk }, styles.muted]}>
                      online
                    </Text>
                  )}
                  <Text style={[styles.status, { color: t.map.chromeInk }, styles.muted]}>·</Text>
                  <Icon source={glyph} size={14} color={glyphColor} />
                </>
              )}
            </View>
          </View>
          <Icon source="chevron-down" size={22} color={t.map.chromeInk} />
        </Pressable>
      )}
      <View
        style={[styles.column, { top: top + PILL_H + COLUMN_GAP }]}
        pointerEvents="box-none"
        onLayout={(e) => setHeight(PILL_H + COLUMN_GAP + e.nativeEvent.layout.height)}
        testID="team-bar-column"
      >
        <AlertBands here={here} onNavigate={onNavigate} />
        <View style={styles.chips} pointerEvents="box-none">
          {chips.map((c) => (
            <Chip key={c.id} spec={c} />
          ))}
        </View>
      </View>
    </View>
  );
}

interface ChipSpec {
  id: string;
  icon: string;
  label: string;
  count?: number;
  accent?: boolean;
  pending?: boolean;
  onPress: () => void;
}

const drawChip: ChipSpec = {
  id: 'draw',
  icon: 'draw',
  label: 'Draw',
  onPress: () => void enterDrawing(),
};

function Chip({ spec }: { spec: ChipSpec }) {
  const t = useSchemeTokens();
  const bg = spec.pending ? t.team.gather : spec.accent ? t.support.accent : t.map.chrome;
  const ink = spec.pending ? t.team.gatherInk : spec.accent ? t.support.onAccent : t.map.chromeInk;
  const count = spec.count ?? 0;
  return (
    <Pressable
      onPress={spec.onPress}
      style={[styles.chip, { backgroundColor: bg, shadowColor: palette.shadow }]}
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `${spec.label}, ${count} unread` : spec.label}
      testID={`team-chip-${spec.id}`}
      hitSlop={6}
    >
      <Icon source={spec.icon} size={18} color={ink} />
      <Text style={[styles.chipLabel, { color: ink }]} numberOfLines={1}>
        {spec.label}
      </Text>
      {count > 0 && (
        <View style={[styles.count, { backgroundColor: t.team.bubbleNew }]}>
          <Text style={[styles.countText, { color: t.team.bubbleNewInk }]}>
            {count > 9 ? '9+' : count}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  pill: {
    position: 'absolute',
    left: 76,
    right: 76,
    height: PILL_H,
    borderRadius: PILL_H / 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 8,
    paddingRight: 8,
    shadowOpacity: 0.28,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  add: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 14, lineHeight: 18, fontWeight: '800' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  status: { fontSize: 12, lineHeight: 15, fontWeight: '700' },
  strong: { fontWeight: '800' },
  muted: { opacity: 0.72 },
  column: { position: 'absolute', left: 16, right: 76, gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    minHeight: 36,
    borderRadius: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 10,
    paddingRight: 12,
    shadowOpacity: 0.26,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  chipLabel: { fontSize: 13.5, fontWeight: '800' },
  count: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: { fontSize: 10.5, fontWeight: '900' },
});
