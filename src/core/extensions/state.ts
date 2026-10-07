/**
 * Map extensions (Settings → Extensions): layers you add to the map on
 * purpose, each installed separately, each with its own switch. Which ones
 * exist, and in which order, is the registry's business (`./registry`).
 *
 * The overlays sheet has ONE "Extensions" row:
 * - nothing installed (or none published) → it leads to Settings → Extensions;
 * - something installed → it opens the Extensions panel in the sheet (each
 *   installed extension's switch and legend, then "Get more extensions").
 *
 * Tidal benchmarks are part of the geodetic layer (its Tidal chip), so they
 * show only while Geodetic points is on, whatever Tide stations is doing.
 */
import { EXTENSIONS } from './registry';
import { EXTENSION_KEYS, type ExtensionKey } from './keys';
import type { ExtensionPrefsMap } from './types';

export interface ExtensionsState {
  /** Extensions whose tiles are published (the others are not offered). */
  available: readonly ExtensionKey[];
  /** Their persisted state (`./prefs`). */
  prefs: ExtensionPrefsMap;
}

export function installedExtensions(s: ExtensionsState): ExtensionKey[] {
  return s.available.filter((k) => s.prefs[k].installedAt > 0);
}

export function extensionShown(s: ExtensionsState, k: ExtensionKey): boolean {
  if (!installedExtensions(s).includes(k)) return false;
  return s.prefs[k].show;
}

/** The extensions the map draws now (installed, published, switched on), in draw order. */
export function shownExtensions(s: ExtensionsState): ExtensionKey[] {
  return installedExtensions(s).filter((k) => s.prefs[k].show);
}

/** Where the overlays sheet's Extensions row goes; null = no row (nothing published). */
export function extensionsRowTarget(s: ExtensionsState): 'settings' | 'panel' | null {
  if (s.available.length === 0) return null;
  return installedExtensions(s).length > 0 ? 'panel' : 'settings';
}

/** The Extensions row's second line. */
export function extensionsRowHint(s: ExtensionsState): string {
  const installed = installedExtensions(s);
  if (installed.length === 0) {
    return `Get ${EXTENSION_KEYS.map((k) => EXTENSIONS[k].teaser).join(', ')}…`;
  }
  const on = installed.filter((k) => extensionShown(s, k)).map((k) => EXTENSIONS[k].label);
  return on.length === 0 ? 'All off' : on.join(' · ');
}

/**
 * Which extensions' tiles an offline pack's style carries:
 * - `'settings'` (what a download uses): the installed ones whose pack policy
 *   says so — always for `'installed'`, with their offline switch on for
 *   `'opt-in'`;
 * - `'all'`: every published one (the full set of templates a pack could
 *   hold today, what the offline-maps health check compares a pack with);
 * - `'none'`: the base layer alone (what a legacy pack is stamped with).
 */
export function packExtensions(
  s: ExtensionsState,
  mode: 'settings' | 'all' | 'none',
): ExtensionKey[] {
  if (mode === 'none') return [];
  if (mode === 'all') return [...s.available];
  return installedExtensions(s).filter(
    (k) => EXTENSIONS[k].offline.packs === 'installed' || s.prefs[k].offline,
  );
}
