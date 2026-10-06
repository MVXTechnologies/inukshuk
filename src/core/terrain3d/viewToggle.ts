/**
 * The map's 3D/2D button (round 3; shown with Settings → Beta features →
 * 3D terrain): from a tilted view it flattens to 2D and remembers the tilt;
 * from a flat view it goes back to that tilt (or a default 3D tilt).
 */

/** Below this the map counts as 2D (the native terrain's ramp starts at 25°). */
export const VIEW_2D_MAX_PITCH = 10;
/** The tilt the button goes to when there is none to return to. */
export const DEFAULT_3D_PITCH = 60;
/** Animation of the pitch change. */
export const VIEW_TOGGLE_MS = 600;

export interface ViewToggle {
  /** The pitch to animate to. */
  pitch: number;
  /** The tilt to remember for the way back (null: keep the remembered one). */
  remember: number | null;
}

/** Whether the map currently reads as 3D (the button then offers 2D). */
export function is3dPitch(pitch: number): boolean {
  return pitch > VIEW_2D_MAX_PITCH;
}

/** What one press does from `pitch`, given the remembered 3D tilt. */
export function toggleView(pitch: number, remembered: number | null, maxPitch = 80): ViewToggle {
  if (is3dPitch(pitch)) return { pitch: 0, remember: pitch };
  const back = remembered !== null && is3dPitch(remembered) ? remembered : DEFAULT_3D_PITCH;
  return { pitch: Math.min(back, maxPitch), remember: null };
}
