/**
 * Display modes (revamp decision 4, `Display-Modes.html`): Normal (Paper &
 * Stone) is the default; Sunlight (max contrast) and Night (red only) are
 * opt-in, never automatic by default. Two toggles can switch them on:
 * "Auto night at sunset" and "Sunlight while recording".
 *
 * Pure: the platform layer feeds the chosen mode, the toggles, whether a
 * recording is running, the clock and today's sun times at the user's
 * position, and renders whatever comes back.
 */

export type DisplayCondition = 'normal' | 'sunlight' | 'night';

export const DISPLAY_CONDITIONS: readonly DisplayCondition[] = ['normal', 'sunlight', 'night'];

export function isDisplayCondition(value: unknown): value is DisplayCondition {
  return value === 'normal' || value === 'sunlight' || value === 'night';
}

export interface DisplayInputs {
  /** The mode the user picked (Normal unless they chose otherwise). */
  chosen: DisplayCondition;
  autoNightAtSunset: boolean;
  sunlightWhileRecording: boolean;
  recording: boolean;
  /** Epoch ms. */
  now: number;
  /** Today's sun times at the user's position, or null when unknown. */
  sun: { sunrise: number | null; sunset: number | null } | null;
  /**
   * Epoch ms until which the automatic night mode is dismissed ("Night on ·
   * tap to exit"), or null.
   */
  autoNightDismissedUntil: number | null;
}

/** Whether it is dark now: after today's sunset or before today's sunrise. */
export function isAfterDark(
  now: number,
  sun: { sunrise: number | null; sunset: number | null } | null,
): boolean {
  if (sun === null || sun.sunrise === null || sun.sunset === null) return false;
  return now >= sun.sunset || now < sun.sunrise;
}

/**
 * The mode actually in effect. An explicit choice of Sunlight or Night always
 * wins. From Normal, the toggles can switch a mode on: auto night after
 * sunset (unless dismissed), then sunlight while recording.
 */
export function effectiveCondition(input: DisplayInputs): DisplayCondition {
  if (input.chosen !== 'normal') return input.chosen;
  const dismissed =
    input.autoNightDismissedUntil !== null && input.now < input.autoNightDismissedUntil;
  if (input.autoNightAtSunset && !dismissed && isAfterDark(input.now, input.sun)) return 'night';
  if (input.sunlightWhileRecording && input.recording) return 'sunlight';
  return 'normal';
}

/**
 * Until when "tap to exit" silences auto night: the next sunrise when it is
 * known, else twelve hours.
 */
export function autoNightDismissalEnd(
  now: number,
  sun: { sunrise: number | null; sunset: number | null } | null,
): number {
  const HALF_DAY = 12 * 3_600_000;
  if (sun?.sunrise != null) {
    const next = sun.sunrise > now ? sun.sunrise : sun.sunrise + 24 * 3_600_000;
    return next;
  }
  return now + HALF_DAY;
}
