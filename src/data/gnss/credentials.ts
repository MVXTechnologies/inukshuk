/**
 * NTRIP caster passwords, by correction-profile id — kept apart from
 * `gnss.json` so the settings file never holds one.
 *
 * WHERE THEY LIVE (flagged for the store build): `expo-secure-store` is not a
 * dependency of this app and adding a native module is out of this change's
 * scope, so they are stored where the app keeps its other secrets today (the
 * Strava tokens, `strava.json`): a JSON file in the app's private documents
 * directory (`gnss-credentials.json`), readable only by the app on a
 * non-rooted device but NOT hardware-encrypted like the Keychain / Keystore,
 * and included in device backups. Swapping in the Keychain / Keystore is this
 * file alone: the rest of the app sees only `SecretStore`.
 */
import * as storage from '@data/storage';

export interface SecretStore {
  get(id: string): Promise<string | null>;
  set(id: string, secret: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Forget every secret (the extension is removed). */
  clear(): Promise<void>;
}

const FILE = 'gnss-credentials.json';

type Doc = { version: 1; secrets: Record<string, string> };

function sanitize(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  const secrets = (raw as { secrets?: unknown }).secrets;
  if (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) return out;
  for (const [k, v] of Object.entries(secrets)) if (typeof v === 'string') out[k] = v;
  return out;
}

class FileSecretStore implements SecretStore {
  private cache: Record<string, string> | null = null;

  private async load(): Promise<Record<string, string>> {
    this.cache ??= sanitize(await storage.readJson<unknown>(FILE));
    return this.cache;
  }

  private save(secrets: Record<string, string>): void {
    this.cache = secrets;
    const doc: Doc = { version: 1, secrets };
    storage.writeJson(FILE, doc);
  }

  async get(id: string): Promise<string | null> {
    return (await this.load())[id] ?? null;
  }

  async set(id: string, secret: string): Promise<void> {
    this.save({ ...(await this.load()), [id]: secret });
  }

  async remove(id: string): Promise<void> {
    const { [id]: _gone, ...rest } = await this.load();
    this.save(rest);
  }

  async clear(): Promise<void> {
    this.save({});
  }
}

export const gnssSecrets: SecretStore = new FileSecretStore();
