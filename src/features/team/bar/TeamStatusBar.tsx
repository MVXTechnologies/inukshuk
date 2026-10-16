/**
 * The team status bar (#707, design C): in team mode it takes the map's
 * search slot. The pill shows the three freshest faces, the team's name,
 * "4/6 online" and the sync glyph (or "Only you", "Offline · 12 min"), the
 * chat's unread count in its label, and an amber "!" while a gather is
 * active (#743, owner's pick "pill only"); a tap opens the team panel, which
 * then opens on the gather. Under the pill (#757, owner: #743 option 1 "with
 * chips"), three small separate pills on ONE row: Chat (unread), Meet here
 * (a rally at my position, with its 5 s undo) and Draw; a guest gets Chat
 * only. They are no longer repeated in the panel. Under them, the column
 * holds an active SOS's red band (#708); a gather has no band on the map.
 *
 * The column's measured height is published (`useTeamBarLayout`) so the
 * map's top-centre chips (destination, marine notice, receiver) move below
 * it instead of colliding with it.
 */
import { MAP_LANE_INSET } from '@core/map/mapChrome';
import { gatherBadge } from '@core/teamui/alertBands';
import { teamBarSummary, type TeamBarSummary } from '@core/teamui/teamBar';
import { selectChatUnread, useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { create } from 'zustand';

import { useTeamSheet } from '../map/teamMode';
import { openPeers } from '../syncLine';
import { AlertBands, useActiveAlerts } from './AlertBands';
import { enterDrawing } from '../draw/TeamDrawMode';
import { FaceStack, myPosition } from './parts';
import { usePendingAlert } from './pendingAlert';

/** The pill's height and the gap to the column under it. */
export const PILL_H = 48;
/**
 * The pill's faces (#756): 22 dp, half covered, so the team's name gets the
 * width (at 360 dp it read "Les Sentie…"), and the name grows with the font
 * scale up to {@link PILL_NAME_MAX_SCALE} (owner's cap).
 */
export const PILL_FACE = 22;
export const PILL_FACE_OVERLAP = 0.5;
export const PILL_NAME_MAX_SCALE = 1.15;
/**
 * The chips under the pill (#757): small enough that Chat (with a count),
 * Meet here and Draw stay on one row of the 268 dp column at 360 dp, with
 * their labels at the 1.15× cap.
 */
export const CHIP_LABEL_MAX_SCALE = 1.15;
export const CHIP = { height: 32, padLeft: 6, padRight: 7, icon: 13, gap: 3, label: 12, rowGap: 5 };
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
  const meshWanted = useTeamStore((s) => s.meshWanted);
  const net = useTeamStore((s) => s.net);
  const internet = pillInternet(net);
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
      meshStarting: meshWanted,
      ...(internet !== undefined ? { internet } : {}),
      now,
    });
  }, [view, positions, peers, meshRunning, meshWanted, internet, now]);
}

/**
 * The team's internet for the pill (#705): `up` in the team's room, `down`
 * when reaching the relay failed; nothing while it is off, not possible in
 * this build, or still connecting (no amber flash during the 0–30 s jitter).
 */
export function pillInternet(
  net: { on: boolean; capable: boolean; online: boolean; room: string } | null,
): 'up' | 'down' | undefined {
  if (net === null || !net.on || !net.capable || !net.online) return undefined;
  return net.room === 'ready' ? 'up' : net.room === 'failing' ? 'down' : undefined;
}

/** The pill's glyph and its colour role for a sync state. */
export function syncGlyph(
  sync: TeamBarSummary['sync'],
  internetOn: boolean,
): {
  icon: string;
  tone: 'ok' | 'warn' | 'lost';
} {
  switch (sync) {
    case 'net':
      return { icon: 'cloud-check-outline', tone: 'ok' };
    case 'noNet':
      return { icon: 'cloud-off-outline', tone: 'warn' };
    case 'lan':
      return { icon: 'access-point', tone: 'ok' };
    case 'look':
      return { icon: 'access-point', tone: 'warn' };
    default:
      return { icon: internetOn ? 'cloud-off-outline' : 'access-point-off', tone: 'lost' };
  }
}

/** Pill text grows to this much of the system font scale at most (map chrome; #756's cap). */
export const PILL_FONT_CAP = PILL_NAME_MAX_SCALE;

/** The pill's geometry (its styles use these), for the 360 dp fit checks (G7 x #756). */
export const PILL_INSET = MAP_LANE_INSET;
const PILL_PAD = 8;
const PILL_GAP = 6;
const STATUS_GAP = 4;
const FACE_BORDER = 2;
const CHEVRON = 16;
export const PILL_GLYPH = 14;
export const PILL_STATUS_GAP = STATUS_GAP;

/** The width left for the pill's text column with `faces` faces, on a screen `screenDp` wide. */
export function pillTextRoom(screenDp: number, faces: number): number {
  const face = PILL_FACE + 2 * FACE_BORDER;
  const overlap = Math.round(PILL_FACE * PILL_FACE_OVERLAP);
  const stack = faces === 0 ? 26 : face + (faces - 1) * (face - overlap);
  return screenDp - 2 * PILL_INSET - 2 * PILL_PAD - stack - 2 * PILL_GAP - CHEVRON;
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
  const summary = useTeamBarSummary();
  const netOn = useTeamStore((s) => s.net?.on === true && s.net.capable);
  const unread = useTeamStore(selectChatUnread);
  const gather = gatherBadge(useActiveAlerts());
  const panelOpen = useTeamSheet((s) => s.sheet?.kind === 'menu');
  const open = useTeamSheet((s) => s.open);
  const setHeight = useTeamBarLayout((s) => s.set);
  const router = useRouter();
  const guest = useTeamStore((s) => s.view?.members.find((m) => m.isMe)?.role === 'guest');
  const pendingRally = usePendingAlert((s) => s.pending?.kind === 'rally');
  useEffect(() => () => setHeight(0), [setHeight]);
  if (summary === null) return null;

  const rallyHere = async () => {
    const at = await myPosition(here);
    if (at !== null) usePendingAlert.getState().start('rally', at);
    else
      usePendingAlert.getState().fail({
        text: 'Your position is unknown: no rally point was set.',
        retry: null,
        sticky: false,
      });
  };
  const chips: ChipSpec[] = [
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
            label: 'Meet here',
            pending: pendingRally,
            onPress: () => void rallyHere(),
          },
          { id: 'draw', icon: 'draw', label: 'Draw', onPress: () => void enterDrawing() },
        ]),
  ];

  const { icon: glyph, tone } = syncGlyph(summary.sync, netOn);
  const glyphColor =
    tone === 'ok' ? t.map.gnssFixed : tone === 'warn' ? t.map.gnssWarn : t.map.gnssLost;
  const offline = summary.sync === 'off' && !summary.solo;
  // The mesh is starting: a neutral word, no count and no alarm colour yet.
  const connecting = summary.sync === 'pending' && !summary.solo;
  const a11y = [
    summary.a11y,
    gather ? 'a gather is active' : null,
    unread > 0 ? `${unread} unread in chat` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {!panelOpen && (
        <Pressable
          onPress={() => open({ kind: 'menu' })}
          style={[styles.pill, { top, backgroundColor: t.map.chrome, shadowColor: palette.shadow }]}
          accessibilityRole="button"
          accessibilityLabel={a11y}
          accessibilityHint={gather ? 'Opens the team panel on the gather' : undefined}
          testID="team-bar-pill"
        >
          {summary.solo ? (
            <View style={[styles.add, { backgroundColor: t.support.accent }]}>
              <Icon source="account-plus" size={17} color={t.support.onAccent} />
            </View>
          ) : (
            // Offline, the longer status takes two faces' room (360 dp, `pillTextRoom`).
            <FaceStack
              faces={offline ? summary.faces.slice(0, 1) : summary.faces}
              size={PILL_FACE}
              overlap={PILL_FACE_OVERLAP}
              ring={t.map.chrome}
            />
          )}
          {/* The unread count rides the Chat chip under the pill (#757), not the faces. */}
          <View style={styles.flex}>
            <Text
              style={[styles.name, { color: t.map.chromeInk }]}
              numberOfLines={1}
              maxFontSizeMultiplier={PILL_NAME_MAX_SCALE}
              testID="team-bar-name"
            >
              {summary.name}
            </Text>
            <View style={styles.statusRow}>
              {connecting ? (
                <Text
                  style={[styles.status, styles.shrink, { color: t.map.chromeInkMuted }]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={PILL_NAME_MAX_SCALE}
                  testID="team-bar-status"
                >
                  {summary.status}
                </Text>
              ) : offline ? (
                <>
                  <Icon source={glyph} size={14} color={glyphColor} />
                  <Text
                    style={[styles.status, styles.shrink, { color: t.map.gnssLost }]}
                    numberOfLines={1}
                    maxFontSizeMultiplier={PILL_NAME_MAX_SCALE}
                    testID="team-bar-status"
                  >
                    {summary.status}
                  </Text>
                </>
              ) : (
                <>
                  {/* One line, one ellipsis policy (#756): "3/3 online ·" never splits. */}
                  <Text
                    style={[styles.status, styles.shrink, { color: t.map.chromeInkMuted }]}
                    numberOfLines={1}
                    maxFontSizeMultiplier={PILL_NAME_MAX_SCALE}
                    testID="team-bar-status"
                  >
                    {/* Spans name their colour: a nested Paper Text takes the theme's
                      own ink (dark on the dark pill in light mode, #756 review). */}
                    <Text
                      style={[styles.strong, { color: t.map.chromeInk }]}
                      testID="team-bar-status-count"
                    >
                      {summary.solo ? summary.status : `${summary.online}/${summary.total}`}
                    </Text>
                    <Text style={{ color: t.map.chromeInkMuted }} testID="team-bar-status-muted">
                      {summary.solo ? ' ·' : ' online ·'}
                    </Text>
                  </Text>
                  {/* The path's glyph (#705): it never shrinks; the text before it does. */}
                  <View testID={`team-bar-glyph-${summary.sync}`}>
                    <Icon source={glyph} size={PILL_GLYPH} color={glyphColor} />
                  </View>
                </>
              )}
            </View>
          </View>
          <Icon source="chevron-down" size={16} color={t.map.chromeInk} />
        </Pressable>
      )}
      {/* The "!" rides the pill's corner, half outside it: its own target (a
        child would only take taps inside the pill's bounds on Android). The
        pill's label already says a gather is active. */}
      {!panelOpen && gather && (
        <Pressable
          onPress={() => open({ kind: 'menu' })}
          style={[
            styles.bang,
            { top: top - 6, backgroundColor: t.team.gather, borderColor: t.map.chrome },
            { shadowColor: palette.shadow },
          ]}
          hitSlop={10}
          accessible={false}
          testID="team-bar-gather"
        >
          <Text style={[styles.bangText, { color: t.team.gatherInk }]} allowFontScaling={false}>
            !
          </Text>
        </Pressable>
      )}
      <View
        style={[styles.column, { top: top + PILL_H + COLUMN_GAP }]}
        pointerEvents="box-none"
        onLayout={(e) => setHeight(PILL_H + COLUMN_GAP + e.nativeEvent.layout.height)}
        testID="team-bar-column"
      >
        <View style={styles.chips} pointerEvents="box-none" testID="team-chips">
          {chips.map((c) => (
            <Chip key={c.id} spec={c} />
          ))}
        </View>
        <AlertBands here={here} onNavigate={onNavigate} scope="map" />
      </View>
    </View>
  );
}

interface ChipSpec {
  id: string;
  icon: string;
  label: string;
  count?: number;
  /** A rally is in its undo countdown: the chip shows it (amber). */
  pending?: boolean;
  onPress: () => void;
}

/** One small pill under the team pill: icon, a one-line label never cut, a count. */
function Chip({ spec }: { spec: ChipSpec }) {
  const t = useSchemeTokens();
  const bg = spec.pending ? t.team.gather : t.map.chrome;
  const ink = spec.pending ? t.team.gatherInk : t.map.chromeInk;
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
      <Icon source={spec.icon} size={CHIP.icon} color={ink} />
      <Text
        style={[styles.chipLabel, { color: ink }]}
        numberOfLines={1}
        maxFontSizeMultiplier={CHIP_LABEL_MAX_SCALE}
        testID={`team-chip-${spec.id}-label`}
      >
        {spec.label}
      </Text>
      {count > 0 && (
        <View style={[styles.count, { backgroundColor: t.team.bubbleNew }]}>
          <Text style={[styles.countText, { color: t.team.bubbleNewInk }]} allowFontScaling={false}>
            {count > 9 ? '9+' : count}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1, minWidth: 0 },
  pill: {
    position: 'absolute',
    left: PILL_INSET,
    right: PILL_INSET,
    height: PILL_H,
    borderRadius: PILL_H / 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: PILL_GAP,
    paddingLeft: PILL_PAD,
    paddingRight: PILL_PAD,
    shadowOpacity: 0.28,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  add: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 14, lineHeight: 18, fontWeight: '800' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: STATUS_GAP },
  status: { fontSize: 12, lineHeight: 15, fontWeight: '700' },
  strong: { fontWeight: '800' },
  column: { position: 'absolute', left: 16, right: MAP_LANE_INSET, gap: 8 },
  // One row, never wrapping (#757): each chip keeps its natural width.
  chips: { flexDirection: 'row', flexWrap: 'nowrap', gap: CHIP.rowGap, alignSelf: 'flex-start' },
  chip: {
    height: CHIP.height,
    borderRadius: CHIP.height / 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: CHIP.gap,
    paddingLeft: CHIP.padLeft,
    paddingRight: CHIP.padRight,
    flexShrink: 0,
    shadowOpacity: 0.26,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  chipLabel: { fontSize: CHIP.label, fontWeight: '800' },
  count: {
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: { fontSize: 10, lineHeight: 12, fontWeight: '900' },
  bang: {
    position: 'absolute',
    // The pill's right edge less the overhang.
    right: PILL_INSET - 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.3,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  bangText: { fontSize: 14, lineHeight: 17, fontWeight: '900' },
});
