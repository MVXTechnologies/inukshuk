/**
 * Secrets in the platform's secure storage (iOS Keychain, Android Keystore-
 * encrypted preferences) through `expo-secure-store`: Strava tokens, NTRIP
 * caster passwords. Security audit finding L4: secrets used to sit in plain
 * JSON files in the documents directory, which device backups copy.
 *
 * - `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: readable while the phone is locked
 *   after its first unlock (NTRIP keeps streaming during a pocketed
 *   recording), never restored to another device from a backup;
 * - every write is read back (`writeSecret` returns whether it verified), so a
 *   migration deletes the old plain copy only after a write that stuck;
 * - loaded lazily and optionally (the `@lib/iap` pattern): a binary without
 *   the native module (pre-2.5.0) gets `null` here instead of a launch crash,
 *   and the callers keep their old storage.
 */
import { requireOptionalNativeModule } from 'expo';
import type * as SecureStoreModule from 'expo-secure-store';

type SecureStoreApi = Pick<
  typeof SecureStoreModule,
  'getItemAsync' | 'setItemAsync' | 'deleteItemAsync' | 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY'
>;

let cached: SecureStoreApi | null | undefined;

function load(): SecureStoreApi | null {
  if (cached !== undefined) return cached;
  try {
    cached =
      requireOptionalNativeModule('ExpoSecureStore') === null
        ? null
        : // eslint-disable-next-line @typescript-eslint/no-require-imports
          (require('expo-secure-store') as SecureStoreApi);
  } catch {
    cached = null;
  }
  return cached;
}

/** Test-only: forget the loaded module. */
export function resetSecureStoreForTests(): void {
  cached = undefined;
}

/** Keys: `[A-Za-z0-9._-]+` only (SecureStore's rule); ours are prefixed. */
export function secretKey(...parts: string[]): string {
  return ['inukshuk', ...parts].join('.').replace(/[^A-Za-z0-9._-]/g, '_');
}

/** This binary has the secure-store module. */
export function secureStoreAvailable(): boolean {
  return load() !== null;
}

function options(s: SecureStoreApi): SecureStoreModule.SecureStoreOptions {
  return { keychainAccessible: s.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
}

export async function readSecret(key: string): Promise<string | null> {
  const s = load();
  return s === null ? null : s.getItemAsync(key, options(s));
}

/** Write, then read back: true only when the stored value is the one written. */
export async function writeSecret(key: string, value: string): Promise<boolean> {
  const s = load();
  if (s === null) return false;
  await s.setItemAsync(key, value, options(s));
  return (await s.getItemAsync(key, options(s))) === value;
}

export async function deleteSecret(key: string): Promise<void> {
  const s = load();
  if (s !== null) await s.deleteItemAsync(key, options(s));
}
