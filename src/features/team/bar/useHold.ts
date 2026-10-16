/**
 * A deliberate hold (#748): the gesture that raises an SOS, for resolving
 * one too. Hold {@link SOS_HOLD_MS}: the ring fills with a short tick each
 * second; past it the hold is armed ("Let go"), and letting go acts. Let go
 * early and nothing happens (`onShort` may say "hold"). A hold that never
 * lets go acts {@link SOS_ARMED_MAX_MS} after arming: a resting finger never
 * blocks it. The timings are `@core/teamui/undo`'s, shared with the SOS
 * button.
 *
 * Releases are read from refs, never from state: a quick tap's press-in and
 * press-out can both land before React re-renders (QA 2.6.1, the SOS button).
 */
import { holdProgress, holdTicks, SOS_ARMED_MAX_MS, SOS_HOLD_MS } from '@core/teamui/undo';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Vibration } from 'react-native';

const FRAME_MS = 50;

export type HoldPhase = 'idle' | 'holding' | 'armed';

export interface Hold {
  phase: HoldPhase;
  /** The ring, 0 → 1 (1 once armed). */
  fraction: number;
  /** Whole seconds left while holding (2, 1). */
  secondsLeft: number;
  down: () => void;
  up: () => void;
}

export function useHold({ onFire, onShort }: { onFire: () => void; onShort?: () => void }): Hold {
  const [held, setHeld] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [armed, setArmed] = useState(false);
  const heldRef = useRef<number | null>(null);
  const armedRef = useRef(false);
  const frame = useRef<ReturnType<typeof setInterval> | null>(null);
  const armedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ticks = useRef(0);
  // The latest callbacks, without restarting a hold when the parent re-renders.
  const fireRef = useRef(onFire);
  const shortRef = useRef(onShort);
  useEffect(() => {
    fireRef.current = onFire;
    shortRef.current = onShort;
  }, [onFire, onShort]);

  const stopFrames = () => {
    if (frame.current !== null) clearInterval(frame.current);
    frame.current = null;
  };
  const disarm = () => {
    armedRef.current = false;
    if (armedTimer.current !== null) clearTimeout(armedTimer.current);
    armedTimer.current = null;
  };
  /** An armed hold acts (once). */
  const fire = useCallback(() => {
    if (!armedRef.current) return;
    disarm();
    setArmed(false);
    fireRef.current();
  }, []);
  useEffect(
    () => () => {
      heldRef.current = null;
      stopFrames();
      disarm();
    },
    [],
  );

  const down = () => {
    if (armedRef.current || heldRef.current !== null) return;
    const start = Date.now();
    ticks.current = 0;
    heldRef.current = start;
    setHeld(start);
    setNow(start);
    stopFrames();
    frame.current = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (heldRef.current !== start) {
        stopFrames();
        return;
      }
      const tick = holdTicks(start, at);
      if (tick > ticks.current) {
        ticks.current = tick;
        Vibration.vibrate(30);
      }
      if (holdProgress(start, at) >= 1) {
        stopFrames();
        heldRef.current = null;
        setHeld(null);
        armedRef.current = true;
        setArmed(true);
        armedTimer.current = setTimeout(fire, SOS_ARMED_MAX_MS);
      }
    }, FRAME_MS);
  };
  const up = () => {
    if (armedRef.current) {
      fire();
      return;
    }
    const start = heldRef.current;
    if (start === null) return;
    heldRef.current = null;
    stopFrames();
    setHeld(null);
    if (holdProgress(start, Date.now()) < 1) shortRef.current?.();
  };

  return {
    phase: armed ? 'armed' : held !== null ? 'holding' : 'idle',
    fraction: armed ? 1 : held === null ? 0 : holdProgress(held, now),
    secondsLeft: held === null ? 0 : Math.max(1, Math.ceil((SOS_HOLD_MS - (now - held)) / 1000)),
    down,
    up,
  };
}
