/**
 * Map extensions (Settings → Extensions): layers you add to the map on
 * purpose. Two today — Geodetic points and Tide stations — each installed
 * separately, each with its own switch.
 *
 * The overlays sheet has ONE "Extensions" row:
 * - nothing installed (or none published) → it leads to Settings → Extensions;
 * - something installed → it opens the Extensions panel in the sheet (each
 *   installed extension's switch and legend, then "Get more extensions").
 *
 * Tidal benchmarks are part of the geodetic layer (its Tidal chip), so they
 * show only while Geodetic points is on, whatever Tide stations is doing.
 *
 * Settings: no migration is needed. Geodetic points keeps its persisted
 * install + switch (`geodeticInstalledAt`, `showGeodetic`), so anyone who had
 * it on keeps it installed and on; Tide stations never shipped before it
 * became an extension (`tidesInstalledAt` defaults to 0, not installed).
 */

export type ExtensionKey = 'geodetic' | 'tides' | 'climbing';

export interface ExtensionsState {
  /** Extensions whose tiles are published (the others are not offered). */
  available: readonly ExtensionKey[];
  geodeticInstalledAt: number;
  showGeodetic: boolean;
  tidesInstalledAt: number;
  showTideStations: boolean;
  /** Climbing crags (absent on callers that predate it: not installed). */
  climbingInstalledAt?: number;
  showClimbing?: boolean;
}

export const EXTENSION_LABEL: Record<ExtensionKey, string> = {
  geodetic: 'Geodetic points',
  tides: 'Tide stations',
  climbing: 'Climbing crags',
};

function installedAt(s: ExtensionsState, k: ExtensionKey): number {
  if (k === 'geodetic') return s.geodeticInstalledAt;
  if (k === 'tides') return s.tidesInstalledAt;
  return s.climbingInstalledAt ?? 0;
}

export function installedExtensions(s: ExtensionsState): ExtensionKey[] {
  return s.available.filter((k) => installedAt(s, k) > 0);
}

export function extensionShown(s: ExtensionsState, k: ExtensionKey): boolean {
  if (!installedExtensions(s).includes(k)) return false;
  if (k === 'geodetic') return s.showGeodetic;
  if (k === 'tides') return s.showTideStations;
  return s.showClimbing ?? false;
}

/** Where the overlays sheet's Extensions row goes; null = no row (nothing published). */
export function extensionsRowTarget(s: ExtensionsState): 'settings' | 'panel' | null {
  if (s.available.length === 0) return null;
  return installedExtensions(s).length > 0 ? 'panel' : 'settings';
}

/** The Extensions row's second line. */
export function extensionsRowHint(s: ExtensionsState): string {
  const installed = installedExtensions(s);
  if (installed.length === 0) return 'Get survey marks, tide stations…';
  const on = installed.filter((k) => extensionShown(s, k)).map((k) => EXTENSION_LABEL[k]);
  return on.length === 0 ? 'All off' : on.join(' · ');
}
