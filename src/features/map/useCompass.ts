import { createHeadingFilter } from '@core/signal/heading';
import * as Location from 'expo-location';

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
// triple the sensor churn and each filter independently (three needles that
// disagree). Instead a single ref-counted watch feeds one heading filter
// (see @core/signal/heading) and fans the result out to listeners.
//
// A note on what this stream actually is, because it drives the filter design:
// on Android `watchHeadingAsync` is **not** the gyro-fused rotation vector. It
// is the accelerometer+magnetometer azimuth (several degrees of noise, even on
// a table), rate-limited to 50 ms and — crucially — only emitted when it has
// moved ≥2° from the last value sent. At rest we therefore receive a stream
// made purely of noise excursions. `createHeadingFilter` is built for exactly
// that: see its module header.
//
// It does report *true* heading (declination-corrected via GeomagneticField)
// plus a calibration level, which we use both to weight the filter and to size
// the direction cone.
// ---------------------------------------------------------------------------

const listeners = new Set<Listener>();
let subscription: Location.LocationSubscription | null = null;
let starting = false;
let latest: CompassSample | null = null;
const filter = createHeadingFilter();

function onHeading(h: Location.LocationHeadingObject): void {
  // trueHeading is -1 when unavailable (no location permission / no fix yet).
  const raw = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
  if (!Number.isFinite(raw)) return;
  const accuracy = Number.isFinite(h.accuracy) ? h.accuracy : null;
  const headingDeg = filter.push({ degrees: raw, timestampMs: Date.now(), accuracy });
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
  filter.reset();
}

/**
 * Subscribe to the shared filtered heading stream. The listener fires at sensor
 * rate (already filtered); apply your own emit-gating if you feed React state.
 * Returns an unsubscribe function; the OS watch stops when the last subscriber
 * leaves.
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
