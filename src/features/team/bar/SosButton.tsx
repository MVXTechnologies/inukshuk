/**
 * The SOS-only button (#707, owner decision 3): the orange team button
 * shrinks to a 48 dp red SOS button in the same corner; the rest of its menu
 * moved into the bar's panel.
 *
 * - Hold {@link SOS_HOLD_MS}: the ring fills, with a short tick each second.
 *   Let go early and nothing happens. Then the 5 s undo (`usePendingAlert`):
 *   nothing is sent during the countdown.
 * - A plain tap only says "Hold to send SOS" (a pocket tap never alarms).
 * - While my SOS is active, the ring stays full and the button says so.
 *
 * The ring redraws every {@link FRAME_MS} only while held: a leaf of the map.
 */
import { holdProgress, holdTicks, SOS_HOLD_MS } from '@core/teamui/undo';
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
  const frame = useRef<ReturnType<typeof setInterval> | null>(null);
  const ticks = useRef(0);

  const stopFrames = () => {
    if (frame.current !== null) clearInterval(frame.current);
    frame.current = null;
  };
  useEffect(() => stopFrames, []);
  useEffect(() => {
    if (hint === null) return;
    const id = setTimeout(() => setHint(null), HINT_MS);
    return () => clearTimeout(id);
  }, [hint]);

  const fire = useCallback(async (from: typeof here) => {
    const at = await myPosition(from);
    if (at === null) {
      setHint('Your position is unknown: say where you are in the chat');
      return;
    }
    usePendingAlert.getState().start('sos', at);
  }, []);

  const down = () => {
    if (mineActive || pendingSos) return;
    const start = Date.now();
    const from = here;
    ticks.current = 0;
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
      if (holdProgress(start, at) >= 1) {
        stopFrames();
        setHeld(null);
        void fire(from);
      }
    }, FRAME_MS);
  };
  const up = () => {
    if (held === null) return;
    stopFrames();
    setHeld(null);
    if (holdProgress(held, Date.now()) < 1) setHint('Hold to send SOS');
  };

  const fraction = mineActive || pendingSos ? 1 : held === null ? 0 : holdProgress(held, now);
  const label = mineActive
    ? 'Your SOS is active'
    : pendingSos
      ? 'SOS about to be sent'
      : 'SOS. Hold for two seconds to alert the whole team';
  return (
    <View style={[styles.dock, { bottom }]} pointerEvents="box-none">
      {hint !== null && (
        <View
          style={[styles.hint, { backgroundColor: t.team.snack, shadowColor: palette.shadow }]}
          accessibilityLiveRegion="polite"
          testID="team-sos-hint"
        >
          <Text style={[styles.hintText, { color: t.team.snackInk }]}>{hint}</Text>
        </View>
      )}
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
          {held !== null
            ? `${Math.max(1, Math.ceil((SOS_HOLD_MS - (now - held)) / 1000))} s`
            : 'Hold'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { position: 'absolute', right: 10, alignItems: 'center', zIndex: 8 },
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
    position: 'absolute',
    right: RING + 4,
    top: RING / 2 - 18,
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
