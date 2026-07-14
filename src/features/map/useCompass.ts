import { createAdaptiveHeadingSmoother, signedDeltaDeg } from '@core/signal/heading';
import * as Location from 'expo-location';
import { useEffect, useState } from 'react';

/** One smoothed compass update delivered to subscribers. */
export interface CompassSample {
  /** Smoothed heading, degrees clockwise from north, [0, 360). */
  headingDeg: number;
  /** Sensor calibration level (0 worst … 3 best), or null if unknown. */
  accuracy: number | null;
}

type Listener = (sample: CompassSample) => void;

// ---------------------------------------------------------------------------
// One shared OS heading watch for the whole app.
//
// The compass badge, the direction cone and the rotate-with-heading camera all
// want the same stream; three separate `watchHeadingAsync` subscriptions would
// triple the sensor churn and each re-smooth independently (three needles that
// disagree). Instead a single ref-counted watch feeds one adaptive smoother
// (see @core/signal/heading) and fans the result out to listeners.
//
// `watchHeadingAsync` is the OS-fused heading (rotation vector on Android,
// CoreLocation on iOS) — far better than a raw magnetometer — and reports true
// heading (declination-corrected) plus a calibration level we use both to gate
// the smoothing and to size the direction cone.
// ---------------------------------------------------------------------------

const listeners = new Set<Listener>();
let subscription: Location.LocationSubscription | null = null;
let starting = false;
let latest: CompassSample | null = null;
const smoother = createAdaptiveHeadingSmoother();

function onHeading(h: Location.LocationHeadingObject): void {
  // trueHeading is -1 when unavailable (no location permission / no fix yet).
  const raw = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
  if (!Number.isFinite(raw)) return;
  const accuracy = Number.isFinite(h.accuracy) ? h.accuracy : null;
  const headingDeg = smoother.push({ degrees: raw, timestampMs: Date.now(), accuracy });
  latest = { headingDeg, accuracy };
  for (const listener of listeners) listener(latest);
}

function ensureWatching(): void {
  if (subscription || starting) return;
  starting = true;
  Location.watchHeadingAsync(onHeading)
    .then((sub) => {
      starting = false;
      if (listeners.size === 0) {
        // Everyone unsubscribed while the watch was starting.
        sub.remove();
        return;
      }
      subscription = sub;
    })
    .catch(() => {
      starting = false; // sensor unavailable — listeners simply never fire
    });
}

function stopWatching(): void {
  subscription?.remove();
  subscription = null;
  latest = null;
  smoother.reset();
}

/**
 * Subscribe to the shared smoothed heading stream. The listener fires at
 * sensor rate (already smoothed); apply your own emit-gating if you feed
 * React state. Returns an unsubscribe function; the OS watch stops when the
 * last subscriber leaves.
 */
export function subscribeHeading(listener: Listener): () => void {
  listeners.add(listener);
  if (latest) listener(latest);
  ensureWatching();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopWatching();
  };
}

/** Minimum circular change (deg) before a new value is pushed to React state. */
const MIN_EMIT_DELTA_DEG = 0.25;

/**
 * Device compass heading (smoothed, [0, 360)) plus sensor accuracy, or null
 * until the first reading. Prefers true heading, falling back to magnetic.
 * Requires location permission to already be granted.
 *
 * Re-renders are gated: state only updates when the smoothed heading moves by
 * at least MIN_EMIT_DELTA_DEG or the reported accuracy changes.
 */
export function useCompass(enabled = true): CompassSample | null {
  const [sample, setSample] = useState<CompassSample | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = subscribeHeading((next) => {
      setSample((prev) =>
        prev !== null &&
        prev.accuracy === next.accuracy &&
        Math.abs(signedDeltaDeg(prev.headingDeg, next.headingDeg)) < MIN_EMIT_DELTA_DEG
          ? prev
          : next,
      );
    });
    return unsubscribe;
  }, [enabled]);

  return enabled ? sample : null;
}
