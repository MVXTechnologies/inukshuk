/**
 * SOS and the rally point on the map (#589, mockups v2 i/j/h/m, approved):
 * - SOS: a press-and-hold of 2 s with a countdown ring raises it (no
 *   accidental alarms); everyone else gets a pinned red banner until the raiser
 *   or an admin resolves it, with Go to / I'm coming / Resolve.
 * - Rally: a compact pill ("Meet 14:00 · 1/5 arrived · you 9 min") that opens
 *   a small card with everyone's ETA and arrival (inside the circle).
 * Big targets, high contrast (sunlight), one-handed reach.
 */
import { metres, rallyArrivals } from '@core/teamui/field';
import { teamService, useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { Button, Icon, IconButton, Text } from 'react-native-paper';

import { MemberAvatar } from '../components';
import { actionMessage } from '../messages';
import { useTeamMapFocus } from './teamMapFocus';

const HOLD_MS = 2_000;

const dist = (m: number) =>
  m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;

/** Hold to raise an SOS. */
export function SosHoldCard({
  here,
  onClose,
}: {
  here: { latitude: number; longitude: number } | null;
  onClose: () => void;
}) {
  const t = useSchemeTokens();
  const [progress] = useState(() => new Animated.Value(0));
  const [left, setLeft] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const started = useRef(0);
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );
  const raise = async () => {
    const session = teamService()?.active;
    if (!session) return;
    let at = here;
    if (at === null) {
      try {
        const fix = await Location.getLastKnownPositionAsync();
        if (fix) at = { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
      } catch {
        // No position: the SOS is still raised where the map last knew me.
      }
    }
    if (at === null) {
      setError('Your position is unknown: say where you are in the chat.');
      return;
    }
    const err = session.raiseSos(at.longitude, at.latitude);
    useTeamStore.getState().refresh();
    if (err) setError(err === 'invalid' ? 'You already have an open SOS.' : actionMessage(err));
    else onClose();
  };
  const down = useCallback(() => {
    started.current = Date.now();
    setLeft(HOLD_MS);
    Animated.timing(progress, { toValue: 1, duration: HOLD_MS, useNativeDriver: false }).start();
    timer.current = setInterval(() => {
      const rest = HOLD_MS - (Date.now() - started.current);
      if (rest <= 0) {
        if (timer.current) clearInterval(timer.current);
        timer.current = null;
        setLeft(null);
        void raise();
      } else setLeft(rest);
    }, 100);
    // raise reads the latest props through its own closure each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress]);
  const up = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setLeft(null);
    progress.stopAnimation();
    progress.setValue(0);
  }, [progress]);
  const ring = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  return (
    <View
      style={[styles.card, { backgroundColor: t.elevation.level2, shadowColor: palette.shadow }]}
      testID="team-sos-card"
    >
      <View style={styles.row}>
        <Pressable
          onPressIn={down}
          onPressOut={up}
          accessibilityRole="button"
          accessibilityLabel="Hold for two seconds to send an SOS to the whole team"
          testID="team-sos-hold"
          style={[styles.sosButton, { backgroundColor: t.team.sos }]}
        >
          <Animated.View style={[styles.sosFill, { height: ring }]} />
          <Text style={[styles.sosText, { color: t.team.sosInk }]}>SOS</Text>
        </Pressable>
        <View style={styles.flex}>
          <Text variant="titleSmall" style={{ color: t.ink }}>
            {left === null ? 'Hold for 2 seconds' : `Keep holding · ${(left / 1000).toFixed(1)} s`}
          </Text>
          <Text variant="bodySmall" style={{ color: t.inkVariant }}>
            Alerts every member at once, even big teams. Your position stays pinned until you or an
            admin resolves it.
          </Text>
          {error !== null && (
            <Text variant="bodySmall" style={{ color: t.team.sos }}>
              {error}
            </Text>
          )}
        </View>
        <IconButton icon="close" size={20} onPress={onClose} accessibilityLabel="Close" />
      </View>
    </View>
  );
}

/** The open SOS banner (pinned at the top) and its card. */
export function SosBanner({
  top,
  here,
  onNavigate,
}: {
  top: number;
  here: { latitude: number; longitude: number } | null;
  onNavigate: (latitude: number, longitude: number) => void;
}) {
  const t = useSchemeTokens();
  const soses = useTeamStore((s) => s.soses);
  const view = useTeamStore((s) => s.view);
  const positions = useTeamStore((s) => s.positions);
  const [open, setOpen] = useState(false);
  const sos = soses.find((s) => !s.resolved);
  if (!sos || view === null) return null;
  const mine = sos.owner === view.me;
  const who = mine ? 'You' : (view.members.find((m) => m.id === sos.owner)?.name ?? 'A teammate');
  const live = positions.find((p) => p.id === sos.owner);
  const at: [number, number] = live ? [live.lon, live.lat] : [sos.lng, sos.lat];
  const d = here ? metres([here.longitude, here.latitude], at) : null;
  const mayResolve = mine || view.isAdmin;
  return (
    <View style={[styles.bannerLane, { top }]} pointerEvents="box-none">
      <Pressable
        onPress={() => {
          setOpen((o) => !o);
          useTeamMapFocus.getState().focus(at[0], at[1], 16);
        }}
        style={[styles.banner, { backgroundColor: t.team.sos }]}
        accessibilityRole="button"
        accessibilityLabel={`SOS: ${who} ${mine ? 'asked for help' : 'needs help'}`}
        testID="team-sos-banner"
      >
        <Icon source="alert-octagon" size={26} color={t.team.sosInk} />
        <View style={styles.flex}>
          <Text style={[styles.bannerTitle, { color: t.team.sosInk }]}>
            {mine ? 'Your SOS is live' : `SOS · ${who} needs help`}
          </Text>
          <Text style={[styles.bannerSub, { color: t.team.sosInk }]}>
            {[
              sos.text || null,
              d !== null && !mine ? `${dist(d)} away` : null,
              live ? 'live' : 'last known',
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
        <Icon source={open ? 'chevron-up' : 'chevron-down'} size={22} color={t.team.sosInk} />
      </Pressable>
      {open && (
        <View
          style={[
            styles.card,
            { backgroundColor: t.elevation.level2, shadowColor: palette.shadow },
          ]}
        >
          <View style={styles.row}>
            {!mine && (
              <Button
                mode="contained"
                icon="navigation-variant"
                buttonColor={t.team.sos}
                textColor={t.team.sosInk}
                style={styles.flex}
                onPress={() => onNavigate(at[1], at[0])}
                testID="team-sos-goto"
              >
                Go to {who.split(' ')[0]}
              </Button>
            )}
            {!mine && (
              <Button
                mode="outlined"
                icon="hand-wave"
                style={styles.flex}
                onPress={() => {
                  teamService()?.active?.sendMessage(`@${who} I’m coming`, {
                    mentions: [sos.owner],
                    pr: 1,
                  });
                  useTeamStore.getState().refresh();
                }}
                testID="team-sos-coming"
              >
                I’m coming
              </Button>
            )}
          </View>
          {mayResolve && (
            <Button
              mode="text"
              icon="check"
              onPress={() => {
                teamService()?.active?.resolveSos(sos.owner, sos.id);
                useTeamStore.getState().refresh();
                setOpen(false);
              }}
              testID="team-sos-resolve"
            >
              {mine ? 'I’m OK · resolve' : 'Resolve'}
            </Button>
          )}
        </View>
      )}
    </View>
  );
}

/** The rally point: a pill, a tap opens who has arrived and everyone's ETA. */
export function RallyPill({
  bottom,
  here,
  onNavigate,
}: {
  bottom: number;
  here: { latitude: number; longitude: number } | null;
  onNavigate: (latitude: number, longitude: number) => void;
}) {
  const t = useSchemeTokens();
  const rally = useTeamStore((s) => s.rally);
  const view = useTeamStore((s) => s.view);
  const positions = useTeamStore((s) => s.positions);
  const [open, setOpen] = useState(false);
  if (!rally || view === null) return null;
  const people = view.members
    .filter((m) => m.active)
    .map((m) => {
      if (m.isMe) return { id: m.id, at: here ? ([here.longitude, here.latitude] as const) : null };
      const p = positions.find((x) => x.id === m.id);
      return { id: m.id, at: p ? ([p.lon, p.lat] as const) : null };
    });
  const arrivals = rallyArrivals(rally, people);
  const arrived = arrivals.filter((a) => a.arrived).length;
  const mine = arrivals.find((a) => a.id === view.me);
  const when = rally.when
    ? new Date(rally.when).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  const line = [
    `Meet${when ? ` ${when}` : ' here'}`,
    `${arrived}/${arrivals.length} arrived`,
    mine?.arrived ? 'you’re there' : mine?.etaMin != null ? `you ~${mine.etaMin} min` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const mayClear = rally.owner === view.me || view.isAdmin;
  return (
    <View style={[styles.rallyDock, { bottom }]} pointerEvents="box-none">
      {open && (
        <View
          style={[
            styles.card,
            { backgroundColor: t.elevation.level2, shadowColor: palette.shadow },
          ]}
          testID="team-rally-card"
        >
          <View style={styles.etaRow}>
            {arrivals.map((a) => {
              const m = view.members.find((x) => x.id === a.id);
              return (
                <View key={a.id} style={styles.eta}>
                  <MemberAvatar
                    initials={m?.initials ?? '?'}
                    color={m?.color ?? t.inkMuted}
                    size={32}
                  />
                  <Text
                    variant="labelSmall"
                    style={{ color: a.arrived ? t.status.gnssFixed : t.inkVariant }}
                  >
                    {a.arrived ? '✓' : a.etaMin === null ? 'lost' : `${a.etaMin} min`}
                  </Text>
                </View>
              );
            })}
          </View>
          <View style={styles.row}>
            <Button
              mode="contained"
              icon="navigation-variant"
              compact
              style={styles.flex}
              onPress={() => onNavigate(rally.lat, rally.lng)}
            >
              Go there
            </Button>
            {mayClear && (
              <Button
                mode="text"
                compact
                onPress={() => {
                  teamService()?.active?.clearRally(rally.owner, rally.id);
                  useTeamStore.getState().refresh();
                  setOpen(false);
                }}
                testID="team-rally-clear"
              >
                Clear
              </Button>
            )}
          </View>
        </View>
      )}
      <Pressable
        onPress={() => setOpen((o) => !o)}
        style={[styles.pill, { backgroundColor: t.elevation.level2, shadowColor: palette.shadow }]}
        accessibilityRole="button"
        accessibilityLabel={`Rally point: ${line}`}
        testID="team-rally-pill"
      >
        <Icon source="flag-variant" size={20} color={t.team.bubbleNew} />
        <Text variant="labelLarge" style={{ color: t.ink }} numberOfLines={1}>
          {line}
        </Text>
        <Icon source={open ? 'chevron-down' : 'chevron-up'} size={20} color={t.inkMuted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  card: {
    borderRadius: 16,
    padding: 12,
    gap: 10,
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  sosButton: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  sosFill: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sosText: { fontSize: 26, fontWeight: '900' },
  bannerLane: { position: 'absolute', left: 8, right: 8, zIndex: 12, gap: 8 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 14,
    padding: 12,
    minHeight: 56,
  },
  bannerTitle: { fontSize: 17, fontWeight: '900' },
  bannerSub: { fontSize: 13, fontWeight: '600' },
  rallyDock: { position: 'absolute', left: 8, right: 84, zIndex: 7, gap: 8 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    borderRadius: 24,
    paddingHorizontal: 14,
    minHeight: 48,
    maxWidth: '100%',
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  etaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  eta: { alignItems: 'center', gap: 2, width: 52 },
});
