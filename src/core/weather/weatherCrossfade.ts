/**
 * Weather drape crossfade slots (weather wave A, field item 3): swapping the
 * single weather source's tile URL per animation frame made MapLibre drop the
 * whole drape and refetch — the map visibly blanked between frames during
 * playback/scrub. Instead the style now carries TWO weather raster slots
 * (A/B): a frame change stages the incoming URL in the *inactive* slot at
 * opacity 0 (MapLibre still fetches tiles for an opacity-0 layer — that IS
 * the prefetch), and only after a short preload window does the active slot
 * flip — the outgoing frame stays on screen until the incoming one is ready,
 * so there is never a blank.
 *
 * Pure state machine; the timing (a preload timer per staged URL) lives in
 * the caller (`useWeatherCrossfade`).
 */

/** Preload window between staging a frame's URL and showing it. Comfortably
 * inside the scrub throttle (SCRUB_THROTTLE_MS = 300) and the playback tick
 * (700 ms), so back-to-back frames still land one per swap. */
export const WEATHER_PRELOAD_MS = 240;

export interface WeatherCrossfadeState {
  /** The two slot URLs; null = slot unused (renders nothing). */
  slots: readonly [string | null, string | null];
  /** Which slot is visible (full opacity); the other sits at opacity 0. */
  activeSlot: 0 | 1;
  /** Slot currently preloading an incoming frame, or null when settled. */
  pendingSlot: 0 | 1 | null;
}

export function crossfadeInit(url: string | null): WeatherCrossfadeState {
  return { slots: [url, null], activeSlot: 0, pendingSlot: null };
}

function otherSlot(slot: 0 | 1): 0 | 1 {
  return slot === 0 ? 1 : 0;
}

function withSlot(
  state: WeatherCrossfadeState,
  slot: 0 | 1,
  url: string | null,
): readonly [string | null, string | null] {
  return slot === 0 ? [url, state.slots[1]] : [state.slots[0], url];
}

/**
 * Stage `url` as the next frame to show. No-ops when it's already the shown
 * frame; scrubbing back to the shown frame cancels a pending swap. When
 * nothing is shown yet (activation), the URL takes the active slot directly —
 * there is no previous frame to hold on screen, so waiting a preload window
 * would only delay the drape.
 */
export function crossfadeTarget(state: WeatherCrossfadeState, url: string): WeatherCrossfadeState {
  if (state.slots[state.activeSlot] === url) {
    return state.pendingSlot === null ? state : { ...state, pendingSlot: null };
  }
  if (state.slots[state.activeSlot] === null) {
    return {
      slots: withSlot(state, state.activeSlot, url),
      activeSlot: state.activeSlot,
      pendingSlot: null,
    };
  }
  const idle = otherSlot(state.activeSlot);
  if (state.pendingSlot === idle && state.slots[idle] === url) return state;
  return { slots: withSlot(state, idle, url), activeSlot: state.activeSlot, pendingSlot: idle };
}

/** Flip the active slot to the preloaded pending one (no-op when settled). */
export function crossfadeCommit(state: WeatherCrossfadeState): WeatherCrossfadeState {
  if (state.pendingSlot === null) return state;
  return { ...state, activeSlot: state.pendingSlot, pendingSlot: null };
}
