/**
 * The SOS-only button (#707, owner decision 3): the orange team button
 * shrinks to a 48 dp red SOS button in the same corner; the rest of its menu
 * moved into the bar's panel.
 *
 * - Hold {@link SOS_HOLD_MS}: the ring fills, with a short tick each second.
 *   Let go early and nothing happens. Past it the SOS is armed ("Let go"),
 *   and letting go starts the 5 s undo (`usePendingAlert`): nothing is sent
 *   during the countdown, and all of it is usable (`SOS_ARMED_MAX_MS`).
 * - A plain tap only says "Hold to send SOS" (a pocket tap never alarms).
 * - While my SOS is active, the ring stays full and the button says so.
 *
 * The ring redraws every {@link FRAME_MS} only while held: a leaf of the map.
 */
import { holdProgress, holdTicks, SOS_ARMED_MAX_MS, SOS_HOLD_MS } from '@core/teamui/undo';
import { MAP_OVERLAY_Z } from '@features/map/overlayOrder';
import { useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Vibration, View } from 'react-native';
import { Text } from 'react-native-paper';

import { myPosition, ProgressRing } from './parts';
import { usePendingAlert } from './pendingAlert';

const FRAME_MS = 50;
const HINT_MS = 2500;
const SIZE = 48;
const RING = SIZE + 16;

export function SosButton({
  bottom,
  here,
}: {
  bottom: number;
  here: { latitude: number; longitude: number } | null;
}) {
  const t = useSchemeTokens();
  const me = useTeamStore((s) => s.view?.me);
  const mineActive = useTeamStore((s) => s.soses.some((x) => x.owner === me && !x.resolved));
  const pendingSos = usePendingAlert((s) => s.pending?.kind === 'sos');
  const [held, setHeld] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  // Held past SOS_HOLD_MS, finger still down: where to send from; the
  // countdown starts on release (or SOS_ARMED_MAX_MS later at the latest).
  const armedRef = useRef<{ from: typeof here } | null>(null);
  const armedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When the current hold began: the timer and the release read this ref.
  const heldRef = useRef<number | null>(null);
  const frame = useRef<ReturnType<typeof setInterval> | null>(null);
  const ticks = useRef(0);

  const stopFrames = () => {
    if (frame.current !== null) clearInterval(frame.current);
    frame.current = null;
  };
  useEffect(() => {
    if (hint === null) return;
    const id = setTimeout(() => setHint(null), HINT_MS);
    return () => clearTimeout(id);
  }, [hint]);

  const fire = useCallback(async (from: typeof here) => {
    const at = await myPosition(from);
    if (at === null) {
      // A failed SOS stays on screen until dismissed, never a passing hint.
      usePendingAlert.getState().fail({
        text: 'SOS not sent: your position is unknown. Say where you are in the chat.',
        retry: null,
        sticky: true,
      });
      return;
    }
    usePendingAlert.getState().start('sos', at);
  }, []);
  /** An armed SOS goes to its undo countdown (once). */
  const launch = useCallback(
    (unmounting = false) => {
      const a = armedRef.current;
      if (a === null) return;
      armedRef.current = null;
      if (armedTimer.current !== null) clearTimeout(armedTimer.current);
      armedTimer.current = null;
      if (!unmounting) setArmed(false);
      void fire(a.from);
    },
    [fire],
  );
  useEffect(
    () => () => {
      heldRef.current = null;
      stopFrames();
      // Hidden mid-hold after arming (a card opened): the SOS still goes to
      // its countdown, which outlives this button (usePendingAlert).
      launch(true);
    },
    [launch],
  );

  const down = () => {
    if (mineActive) {
      // Said up front, never a countdown that would end in "already open".
      setHint('Your SOS is already active');
      return;
    }
    if (pendingSos || armedRef.current !== null) return;
    const start = Date.now();
    const from = here;
    ticks.current = 0;
    heldRef.current = start;
    setHeld(start);
    setNow(start);
    stopFrames();
    frame.current = setInterval(() => {
      const at = Date.now();
      setNow(at);
      const tick = holdTicks(start, at);
      if (tick > ticks.current) {
        ticks.current = tick;
        Vibration.vibrate(30);
      }
      // A release already ended this hold (the ref, never the state: a quick
      // tap can release before React re-renders, QA 2.6.1).
      if (heldRef.current !== start) {
        stopFrames();
        return;
      }
      if (holdProgress(start, at) >= 1) {
        stopFrames();
        heldRef.current = null;
        setHeld(null);
        armedRef.current = { from };
        setArmed(true);
        armedTimer.current = setTimeout(() => launch(), SOS_ARMED_MAX_MS);
      }
    }, FRAME_MS);
  };
  const up = () => {
    if (armedRef.current !== null) {
      launch();
      return;
    }
    // The ref, not `held`: press-in and press-out can both land before the
    // re-render, and a stale `held` (null) let the timer run on to an SOS (#708).
    const start = heldRef.current;
    if (start === null) return;
    heldRef.current = null;
    stopFrames();
    setHeld(null);
    if (holdProgress(start, Date.now()) < 1) setHint('Hold to send SOS');
  };

  const fraction =
    mineActive || pendingSos || armed ? 1 : held === null ? 0 : holdProgress(held, now);
  const label = mineActive
    ? 'Your SOS is active'
    : pendingSos
      ? 'SOS about to be sent'
      : armed
        ? 'SOS ready. Let go to start the five second undo'
        : 'SOS. Hold for two seconds to alert the whole team';
  return (
    <View style={[styles.dock, { bottom }]} pointerEvents="box-none" testID="team-sos-layer">
      {hint !== null && (
        // Inside the dock's own bounds (a row, left of the button), never
        // absolutely placed outside them: Android leaves a view outside its
        // parent's bounds out of the accessibility tree, so TalkBack never
        // announced the hint and E2E could not see it (QA 2.6.1).
        <View
          style={[styles.hint, { backgroundColor: t.team.snack, shadowColor: palette.shadow }]}
          accessibilityLiveRegion="polite"
          pointerEvents="none"
          testID="team-sos-hint"
        >
          <Text style={[styles.hintText, { color: t.team.snackInk }]}>{hint}</Text>
        </View>
      )}
      <View style={styles.column} pointerEvents="box-none">
        <View style={styles.ringBox}>
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <ProgressRing
              size={RING}
              stroke={3.5}
              fraction={fraction}
              color={t.team.sos}
              track={`${t.team.sos}4D`}
            />
          </View>
          <Pressable
            onPressIn={down}
            onPressOut={up}
            style={[
              styles.button,
              {
                backgroundColor: t.team.sos,
                borderColor: t.team.mapHalo,
                shadowColor: palette.shadow,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint={mineActive ? undefined : 'Touch and hold'}
            accessibilityState={{ busy: held !== null }}
            testID="team-sos-button"
          >
            <Text style={[styles.sos, { color: t.team.sosInk }]} allowFontScaling={false}>
              SOS
            </Text>
          </Pressable>
        </View>
        {!mineActive && (
          <Text
            style={[styles.under, { color: t.team.mapInk, textShadowColor: t.team.mapHalo }]}
            allowFontScaling={false}
            accessible={false}
          >
            {armed
              ? 'Let go'
              : held !== null
                ? `${Math.max(1, Math.ceil((SOS_HOLD_MS - (now - held)) / 1000))} s`
                : 'Hold'}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Under the bottom cards (QA 2.6.0, 09b); the button's elevation stays inside.
  dock: {
    position: 'absolute',
    right: 10,
    flexDirection: 'row',
    alignItems: 'flex-start',
    zIndex: MAP_OVERLAY_Z.teamButton,
  },
  column: { alignItems: 'center' },
  ringBox: {
    width: RING,
    height: RING,
    alignItems: 'center',
    justifyContent: 'center',
  },
  button: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: 2.5,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.32,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  sos: { fontSize: 13.5, fontWeight: '900', letterSpacing: 0.5 },
  under: {
    marginTop: -6,
    fontSize: 11,
    fontWeight: '800',
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 0 },
  },
  hint: {
    marginTop: RING / 2 - 18,
    marginRight: 4,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    maxWidth: 240,
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 5,
  },
  hintText: { fontSize: 13.5, fontWeight: '700' },
});
