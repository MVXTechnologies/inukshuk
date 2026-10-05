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

export type ExtensionKey = 'geodetic' | 'tides';

export interface ExtensionsState {
  /** Extensions whose tiles are published (the others are not offered). */
  available: readonly ExtensionKey[];
  geodeticInstalledAt: number;
  showGeodetic: boolean;
  tidesInstalledAt: number;
  showTideStations: boolean;
}

export const EXTENSION_LABEL: Record<ExtensionKey, string> = {
  geodetic: 'Geodetic points',
  tides: 'Tide stations',
};

export function installedExtensions(s: ExtensionsState): ExtensionKey[] {
  return s.available.filter((k) =>
    k === 'geodetic' ? s.geodeticInstalledAt > 0 : s.tidesInstalledAt > 0,
  );
}

export function extensionShown(s: ExtensionsState, k: ExtensionKey): boolean {
  if (!installedExtensions(s).includes(k)) return false;
  return k === 'geodetic' ? s.showGeodetic : s.showTideStations;
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
