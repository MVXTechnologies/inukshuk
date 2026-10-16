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
 *
 * #756: a button of the right rail's column (`@core/map/mapChrome`): its
 * centre on the rail's axis, {@link MAP_EDGE_INSET} from the edge like Locate,
 * Layers and +, and its bottom edge at `bottom` (the caller puts that
 * `MAP_STACK_GAP` above the bottom row). The ring hugs it ({@link RING_PAD}
 * outside) and the "HOLD" cue is inside the button, never a label under it.
 *
 * It swells while held (owner): 1× → 1.35× over the hold, eased
 * (`@core/teamui/holdScale`), on the UI thread from a shared value; let go
 * early and it springs back; armed, it settles back. Only the drawing scales,
 * about its centre: the touch target and the dock never move.
 */
import { holdScale } from '@core/teamui/holdScale';
import { holdProgress, holdTicks, SOS_ARMED_MAX_MS, SOS_HOLD_MS } from '@core/teamui/undo';
import { MAP_BUTTON, MAP_EDGE_INSET, onColumnRight } from '@core/map/mapChrome';
import { useMapChrome } from '@features/map/useMapChrome';
import { MAP_OVERLAY_Z } from '@features/map/overlayOrder';
import { useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Vibration, View } from 'react-native';
import { Text } from '@ui/paper';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { myPosition, ProgressRing } from './parts';
import { usePendingAlert } from './pendingAlert';
import { useDisplayScale, useScaledStyles } from '@ui/displayScale';

const FRAME_MS = 50;
const HINT_MS = 2500;
const SIZE = MAP_BUTTON;
/** The ring's reach outside the button. */
export const RING_PAD = 4;
const RING = SIZE + 2 * RING_PAD;
/** Back to rest after an early release or once armed: quick, a touch of bounce. */
export const SWELL_RELEASE_SPRING = { damping: 14, stiffness: 220, mass: 0.6 } as const;

export function SosButton({
  bottom,
  here,
}: {
  /** Where the button's bottom edge sits (its ring reaches {@link RING_PAD} below). */
  bottom: number;
  here: { latitude: number; longitude: number } | null;
}) {
  const styles = useScaledStyles(stylesSheet);
  // #760: a button of the rail's column at the Display size; its ring box is
  // centred on the column's axis, the button never under 48 dp.
  const chrome = useMapChrome();
  const { sp } = useDisplayScale();
  const ringPad = sp(RING_PAD);
  const size = chrome.button;
  const ring = size + 2 * ringPad;
  const box = { width: ring, height: ring };
  const round = { width: size, height: size, borderRadius: size / 2 };

  const t = useSchemeTokens();
  const me = useTeamStore((s) => s.view?.me);
  const mineActive = useTeamStore((s) => s.soses.some((x) => x.owner === me && !x.resolved));
  const pendingSos = usePendingAlert((s) => s.pending?.kind === 'sos');
  const [held, setHeld] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  // The hold's progress, 0–1, animated on the UI thread: the swell reads it.
  const swell = useSharedValue(0);
  const swellStyle = useAnimatedStyle(() => ({ transform: [{ scale: holdScale(swell.get()) }] }));
  const swellTo = useCallback(
    (to: 0 | 1) => {
      cancelAnimation(swell);
      swell.set(
        to === 1
          ? withTiming(1, { duration: SOS_HOLD_MS, easing: Easing.linear })
          : withSpring(0, SWELL_RELEASE_SPRING),
      );
    },
    [swell],
  );
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
  // Apart from the hold's own cleanup: that one must run only on unmount.
  useEffect(() => () => cancelAnimation(swell), [swell]);

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
    swellTo(1);
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
        // Armed: the swell settles back while "Let go" shows.
        swellTo(0);
        armedTimer.current = setTimeout(() => launch(), SOS_ARMED_MAX_MS);
      }
    }, FRAME_MS);
  };
  const up = () => {
    if (armedRef.current !== null) {
      launch();
      return;
    }
    // Let go before the hold completed: the swell springs back.
    swellTo(0);
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
    <View
      style={[styles.dock, { right: onColumnRight(chrome, ring), bottom: bottom - ringPad }]}
      pointerEvents="box-none"
      testID="team-sos-layer"
    >
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
        <View style={[styles.ringBox, box]}>
          {/* The ring swells with the button (the same scale, about the same centre). */}
          <Animated.View
            style={[StyleSheet.absoluteFill, swellStyle]}
            pointerEvents="none"
            testID="team-sos-ring-swell"
          >
            <ProgressRing
              size={ring}
              stroke={3.5}
              fraction={fraction}
              color={t.team.sos}
              track={`${t.team.sos}4D`}
            />
          </Animated.View>
          {/* The touch target keeps its 48 dp and its place; only its drawing swells. */}
          <Pressable
            onPressIn={down}
            onPressOut={up}
            style={[styles.button, round]}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint={mineActive ? undefined : 'Touch and hold'}
            accessibilityState={{ busy: held !== null }}
            testID="team-sos-button"
          >
            <Animated.View
              style={[
                styles.disc,
                { borderRadius: size / 2 },
                {
                  backgroundColor: t.team.sos,
                  borderColor: t.team.mapHalo,
                  shadowColor: palette.shadow,
                },
                swellStyle,
              ]}
              pointerEvents="none"
              testID="team-sos-swell"
            >
              <Text style={[styles.sos, { color: t.team.sosInk }]} allowFontScaling={false}>
                SOS
              </Text>
              {!mineActive && (
                <Text
                  style={[styles.cue, { color: t.team.sosInk }]}
                  allowFontScaling={false}
                  accessible={false}
                  testID="team-sos-cue"
                >
                  {armed
                    ? 'Let go'
                    : held !== null
                      ? `${Math.max(1, Math.ceil((SOS_HOLD_MS - (now - held)) / 1000))} s`
                      : 'Hold'}
                </Text>
              )}
            </Animated.View>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const stylesSheet = StyleSheet.create({
  // Under the bottom cards (QA 2.6.0, 09b); the button's elevation stays inside.
  // The ring box's right edge sits RING_PAD outside the button's, which is
  // MAP_EDGE_INSET from the screen's edge: the rail's column.
  dock: {
    position: 'absolute',
    right: MAP_EDGE_INSET - RING_PAD,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: MAP_OVERLAY_Z.teamButton,
  },
  column: { alignItems: 'center' },
  ringBox: {
    width: RING,
    height: RING,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The touch target: fixed, never scaled.
  button: { width: SIZE, height: SIZE, borderRadius: SIZE / 2 },
  // The drawn button, which swells.
  disc: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: SIZE / 2,
    borderWidth: 2.5,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.32,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  sos: { fontSize: 13.5, lineHeight: 15, fontWeight: '900', letterSpacing: 0.5 },
  // Inside the 48 dp button, so it never meets the bottom row (#756).
  cue: {
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '800',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    opacity: 0.92,
  },
  hint: {
    marginRight: 8,
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
