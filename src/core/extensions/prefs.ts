/**
 * The extensions' persisted state: one `extensions` entry in settings.json,
 * `{ [key]: { installedAt, show, offline } }`, and its migration from the flat
 * keys the first two extensions shipped with (`geodeticInstalledAt`,
 * `showGeodetic`, `geodeticOffline`, `tidesInstalledAt`, `showTideStations`).
 *
 * Rollback-safe both ways:
 * - reading: a file from before the registry has only the flat keys; they
 *   are read field by field (a junk or missing value takes the default), so
 *   an installed extension stays installed with its switches as they were;
 * - writing: the flat keys are still written next to `extensions`
 *   ({@link legacyExtensionFields}). A build from before the registry (an OTA
 *   rollback) knows only those, reads the same state, and drops `extensions`
 *   when it next saves; the newer build then reads the flat keys again.
 */
import { extensionBasics } from './registry';
import { ALL_EXTENSION_KEYS, type AnyExtensionKey } from './keys';
import type { ExtensionPrefs, ExtensionPrefsMap } from './types';

/** Every extension not installed, with its descriptor's default switches. */
export function defaultExtensionPrefs(): ExtensionPrefsMap {
  const out = {} as ExtensionPrefsMap;
  for (const key of ALL_EXTENSION_KEYS)
    out[key] = { installedAt: 0, ...extensionBasics(key).defaults };
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const installedAtOk = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0;
const boolOk = (v: unknown): v is boolean => typeof v === 'boolean';

/**
 * The extensions' state from a parsed settings.json of any version (or junk):
 * per extension and per field, the `extensions` entry's value, else the
 * pre-registry flat key's, else the default. Never throws.
 */
export function migrateExtensionPrefs(raw: unknown): ExtensionPrefsMap {
  const doc = asRecord(raw) ?? {};
  const saved = asRecord(doc.extensions) ?? {};
  const out = defaultExtensionPrefs();
  for (const key of ALL_EXTENSION_KEYS) {
    const entry = asRecord(saved[key]) ?? {};
    const legacy = extensionBasics(key).legacySettings;
    const pick = <T>(
      field: keyof ExtensionPrefs,
      ok: (v: unknown) => v is T,
      legacyKey: string | undefined,
    ): T | undefined => {
      if (ok(entry[field])) return entry[field];
      if (legacyKey !== undefined && ok(doc[legacyKey])) return doc[legacyKey];
      return undefined;
    };
    const prefs = out[key];
    prefs.installedAt = pick('installedAt', installedAtOk, legacy?.installedAt) ?? 0;
    prefs.show = pick('show', boolOk, legacy?.show) ?? prefs.show;
    prefs.offline = pick('offline', boolOk, legacy?.offline) ?? prefs.offline;
  }
  return out;
}

/**
 * The pre-registry flat keys for `prefs`, written next to `extensions` so an
 * older build reads the same state (see the module comment).
 */
export function legacyExtensionFields(prefs: ExtensionPrefsMap): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const key of ALL_EXTENSION_KEYS) {
    const legacy = extensionBasics(key).legacySettings;
    if (!legacy) continue;
    const p = prefs[key];
    out[legacy.installedAt] = p.installedAt;
    out[legacy.show] = p.show;
    if (legacy.offline !== undefined) out[legacy.offline] = p.offline;
  }
  return out;
}

/** `prefs` with one extension's fields replaced (a new object: store-safe). */
export function withExtensionPrefs(
  prefs: ExtensionPrefsMap,
  key: AnyExtensionKey,
  patch: Partial<ExtensionPrefs>,
): ExtensionPrefsMap {
  return { ...prefs, [key]: { ...prefs[key], ...patch } };
}
