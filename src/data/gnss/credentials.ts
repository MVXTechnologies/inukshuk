/**
 * NTRIP caster passwords, by correction-profile id, in the platform's secure
 * storage (`@data/secureStore`: Keychain / Keystore, this device only) —
 * never in `gnss.json`. SecureStore can't list its keys, so the ids with a
 * password are kept in an index entry (ids only, no secret) for `clear()`.
 */
import { deleteSecret, readSecret, secretKey, writeSecret } from '@data/secureStore';

export interface SecretStore {
  get(id: string): Promise<string | null>;
  /** Rejects when the password could not be stored (and verified). */
  set(id: string, secret: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Forget every password (the extension is removed). */
  clear(): Promise<void>;
}

const INDEX = secretKey('ntrip', 'index');
const keyOf = (id: string) => secretKey('ntrip', 'pw', id);

async function ids(): Promise<string[]> {
  try {
    const raw = JSON.parse((await readSecret(INDEX)) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function saveIds(list: string[]): Promise<void> {
  if (list.length === 0) await deleteSecret(INDEX);
  else await writeSecret(INDEX, JSON.stringify(list));
}

class SecureSecretStore implements SecretStore {
  async get(id: string): Promise<string | null> {
    return readSecret(keyOf(id));
  }

  async set(id: string, secret: string): Promise<void> {
    if (!(await writeSecret(keyOf(id), secret))) {
      throw new Error('Couldn’t store the password securely on this device');
    }
    const list = await ids();
    if (!list.includes(id)) await saveIds([...list, id]);
  }

  async remove(id: string): Promise<void> {
    await deleteSecret(keyOf(id));
    await saveIds((await ids()).filter((x) => x !== id));
  }

  async clear(): Promise<void> {
    for (const id of await ids()) await deleteSecret(keyOf(id));
    await saveIds([]);
  }
}

export const gnssSecrets: SecretStore = new SecureSecretStore();
