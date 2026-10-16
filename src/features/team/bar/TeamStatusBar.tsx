/**
 * The team status bar (#707, design C): in team mode it takes the map's
 * search slot. The pill shows the three freshest faces, the team's name,
 * "4/6 online" and the sync glyph (or "Only you", "Offline · 12 min"), the
 * chat's unread count on the faces, and an amber "!" while a gather is
 * active (#743, owner's pick "pill only"); a tap opens the team panel, which
 * then opens on the gather. Chat, Rally here and Draw live in the panel: the
 * map keeps no chip row. Under the pill, the column holds an active SOS's
 * red band (#708); a gather has no band on the map.
 *
 * The column's measured height is published (`useTeamBarLayout`) so the
 * map's top-centre chips (destination, marine notice, receiver) move below
 * it instead of colliding with it.
 */
import { gatherBadge } from '@core/teamui/alertBands';
import { teamBarSummary, type TeamBarSummary } from '@core/teamui/teamBar';
import { selectChatUnread, useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { create } from 'zustand';

import { useTeamSheet } from '../map/teamMode';
import { openPeers } from '../syncLine';
import { AlertBands, useActiveAlerts } from './AlertBands';
import { FaceStack } from './parts';

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

/** Pill text grows to this much of the system font scale at most (map chrome). */
export const PILL_FONT_CAP = 1.15;

/** The pill's geometry (its styles use these), for the 360 dp fit checks. */
export const PILL_INSET = 76;
const PILL_PAD = 6;
const PILL_GAP = 8;
const STATUS_GAP = 3;
const FACE = 24;
const FACE_BORDER = 2;
const CHEVRON = 22;
export const PILL_GLYPH = 14;
export const PILL_STATUS_GAP = STATUS_GAP;

/** The width left for the pill's text column with `faces` faces, on a screen `screenDp` wide. */
export function pillTextRoom(screenDp: number, faces: number): number {
  const face = FACE + 2 * FACE_BORDER;
  const overlap = Math.round(FACE * 0.3);
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
  useEffect(() => () => setHeight(0), [setHeight]);
  if (summary === null) return null;

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
              size={24}
              ring={t.map.chrome}
            />
          )}
          {unread > 0 && (
            <View
              style={[
                styles.unread,
                { backgroundColor: t.team.bubbleNew, borderColor: t.map.chrome },
              ]}
              testID="team-bar-unread"
            >
              <Text
                style={[styles.unreadText, { color: t.team.bubbleNewInk }]}
                allowFontScaling={false}
              >
                {unread > 9 ? '9+' : unread}
              </Text>
            </View>
          )}
          <View style={styles.flex}>
            <Text
              style={[styles.name, { color: t.map.chromeInk }]}
              numberOfLines={1}
              maxFontSizeMultiplier={PILL_FONT_CAP}
            >
              {summary.name}
            </Text>
            <View style={styles.statusRow}>
              {connecting ? (
                <Text
                  style={[styles.status, { color: t.map.chromeInk }, styles.muted]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={PILL_FONT_CAP}
                  testID="team-bar-status"
                >
                  {summary.status}
                </Text>
              ) : offline ? (
                <>
                  <Icon source={glyph} size={14} color={glyphColor} />
                  <Text
                    style={[styles.status, { color: t.map.gnssLost }]}
                    numberOfLines={1}
                    maxFontSizeMultiplier={PILL_FONT_CAP}
                    testID="team-bar-status"
                  >
                    {summary.status}
                  </Text>
                </>
              ) : (
                <>
                  {/* The glyph first, so it is never the part that runs out of room. */}
                  <View testID={`team-bar-glyph-${summary.sync}`}>
                    <Icon source={glyph} size={14} color={glyphColor} />
                  </View>
                  <Text
                    style={[styles.status, styles.strong, { color: t.map.chromeInk }]}
                    numberOfLines={1}
                    maxFontSizeMultiplier={PILL_FONT_CAP}
                    testID="team-bar-status"
                  >
                    {summary.solo ? summary.status : `${summary.online}/${summary.total}`}
                  </Text>
                  {/* "12/12" leaves no room for the word at 360 dp (`pillTextRoom`). */}
                  {!summary.solo && `${summary.online}/${summary.total}`.length <= 3 && (
                    <Text
                      style={[styles.status, { color: t.map.chromeInk }, styles.muted]}
                      numberOfLines={1}
                      maxFontSizeMultiplier={PILL_FONT_CAP}
                    >
                      online
                    </Text>
                  )}
                </>
              )}
            </View>
          </View>
          <Icon source="chevron-down" size={22} color={t.map.chromeInk} />
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
        <AlertBands here={here} onNavigate={onNavigate} scope="map" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
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
  muted: { opacity: 0.72 },
  column: { position: 'absolute', left: 16, right: 76, gap: 8 },
  unread: {
    position: 'absolute',
    left: 22,
    top: 4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    paddingHorizontal: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadText: { fontSize: 10, lineHeight: 12, fontWeight: '900' },
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
