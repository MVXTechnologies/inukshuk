/**
 * Team drawing's local settings (#683), `team-draw.json`: the style (set
 * once, kept on this phone, never synced), the last tool, and how many times
 * the "two fingers move the map" hint has shown. Read back raw: the core's
 * `normalisePrefs` repairs any field (`@core/teamdraw/style`).
 */
import * as storage from './storage';

export const TEAM_DRAW_FILE = 'team-draw.json';

export interface StoredDraw {
  prefs?: unknown;
  tool?: unknown;
  hints?: unknown;
}

export async function loadTeamDraw(): Promise<StoredDraw> {
  try {
    const v = await storage.readJson<unknown>(TEAM_DRAW_FILE);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as StoredDraw) : {};
  } catch {
    return {};
  }
}

/** Best effort: losing a style write must never break drawing. */
export function saveTeamDraw(v: StoredDraw): void {
  try {
    storage.writeJson(TEAM_DRAW_FILE, v);
  } catch {
    // The style just isn't remembered this time.
  }
}
