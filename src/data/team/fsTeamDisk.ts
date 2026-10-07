/**
 * `TeamDisk` on the real file system (SDK 56 `File`/`Directory` API) and the
 * secure store. See `./teamDisk` for the layout and the durability rules.
 */
import type { WriterCursor } from '@core/team/actions';
import { isTeamId } from '@core/team/ids';
import { readSecret, secretKey, writeSecret } from '@data/secureStore';
import { readJson, writeJson } from '@data/storage';
import { Directory, File, Paths } from 'expo-file-system';

import {
  isWriterCursor,
  parseOpLines,
  type DeviceSecrets,
  type TeamDisk,
  type TeamRecord,
} from './teamDisk';

const ROOT = 'teams';
const INDEX = `${ROOT}/index.json`;
const DEVICE_SECRET = secretKey('team', 'device');

function teamDir(teamId: string): Directory {
  // Team ids are 22 base64url characters: safe as a directory name. Anything
  // else never reaches the file system.
  if (!isTeamId(teamId)) throw new Error('bad team id');
  return new Directory(Paths.document, ROOT, teamId);
}

function ensureDir(dir: Directory): void {
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
}

function isDeviceSecrets(v: unknown): v is DeviceSecrets {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return s['v'] === 1 && typeof s['sign'] === 'string' && typeof s['box'] === 'string';
}

export const fsTeamDisk: TeamDisk = {
  async loadDevice() {
    const text = await readSecret(DEVICE_SECRET);
    if (text === null) return null;
    try {
      const v = JSON.parse(text) as unknown;
      return isDeviceSecrets(v) ? v : null;
    } catch {
      return null;
    }
  },

  saveDevice(secrets) {
    return writeSecret(DEVICE_SECRET, JSON.stringify(secrets));
  },

  async loadTeams() {
    const list = await readJson<unknown>(INDEX);
    return Array.isArray(list)
      ? list.filter((t): t is TeamRecord => {
          const r = t as Partial<TeamRecord> | null;
          return typeof r?.teamId === 'string' && isTeamId(r.teamId) && typeof r.prefs === 'object';
        })
      : [];
  },

  saveTeams(teams) {
    ensureDir(new Directory(Paths.document, ROOT));
    writeJson(INDEX, teams);
  },

  async loadOps(teamId) {
    const file = new File(teamDir(teamId), 'ops.jsonl');
    return file.exists ? parseOpLines(await file.text()) : [];
  },

  appendOps(teamId, envelopes) {
    if (envelopes.length === 0) return;
    const dir = teamDir(teamId);
    ensureDir(dir);
    const file = new File(dir, 'ops.jsonl');
    if (!file.exists) file.create();
    file.write(envelopes.map((e) => `${JSON.stringify(e)}\n`).join(''), { append: true });
  },

  async loadCursor(teamId) {
    const v = await readJson<unknown>(`${ROOT}/${teamDir(teamId).name}/cursor.json`);
    return isWriterCursor(v) ? (v as WriterCursor) : null;
  },

  saveCursor(teamId, cursor) {
    ensureDir(teamDir(teamId));
    writeJson(`${ROOT}/${teamDir(teamId).name}/cursor.json`, cursor);
  },

  deleteTeam(teamId) {
    const dir = teamDir(teamId);
    if (dir.exists) dir.delete();
  },
};
