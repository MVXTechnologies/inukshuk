/**
 * A simulated teammate's "phone storage" (demo builds only): the same
 * `TeamDisk` contract as the real one, in plain files under
 * `team-sim/<bot>/`, so the bots keep their identity, their op log and their
 * writer cursor across app restarts (no secure store: they are not people).
 */
import type { WriterCursor } from '@core/team/actions';
import {
  isWriterCursor,
  parseOpLines,
  type DeviceSecrets,
  type TeamDisk,
  type TeamRecord,
} from '@data/team/teamDisk';
import { Directory, File, Paths } from 'expo-file-system';

export const SIM_ROOT = 'team-sim';
const SAFE = /^[A-Za-z0-9_-]{1,64}$/;

function readJsonFile<T>(file: File): T | null {
  try {
    return file.exists ? (JSON.parse(file.textSync()) as T) : null;
  } catch {
    return null;
  }
}

function writeJsonFile(file: File, value: unknown): void {
  const tmp = new File(file.parentDirectory, `${file.name}.tmp`);
  if (tmp.exists) tmp.delete();
  tmp.create();
  tmp.write(JSON.stringify(value));
  tmp.moveSync(file, { overwrite: true });
}

export class SimBotDisk implements TeamDisk {
  private readonly dir: Directory;

  constructor(key: string) {
    if (!SAFE.test(key)) throw new Error('bad sim bot key');
    this.dir = new Directory(Paths.document, SIM_ROOT, key);
    if (!this.dir.exists) this.dir.create({ intermediates: true, idempotent: true });
  }

  private file(name: string): File {
    return new File(this.dir, name);
  }

  async loadDevice(): Promise<DeviceSecrets | null> {
    return readJsonFile<DeviceSecrets>(this.file('device.json'));
  }

  async saveDevice(secrets: DeviceSecrets): Promise<boolean> {
    writeJsonFile(this.file('device.json'), secrets);
    return true;
  }

  async loadTeams(): Promise<TeamRecord[]> {
    return readJsonFile<TeamRecord[]>(this.file('teams.json')) ?? [];
  }

  saveTeams(teams: readonly TeamRecord[]): void {
    writeJsonFile(this.file('teams.json'), teams);
  }

  async loadOps(teamId: string): Promise<unknown[]> {
    if (!SAFE.test(teamId)) return [];
    const f = this.file(`ops-${teamId}.jsonl`);
    return f.exists ? parseOpLines(await f.text()) : [];
  }

  appendOps(teamId: string, envelopes: readonly unknown[]): void {
    if (envelopes.length === 0 || !SAFE.test(teamId)) return;
    const f = this.file(`ops-${teamId}.jsonl`);
    if (!f.exists) f.create();
    f.write(envelopes.map((e) => `${JSON.stringify(e)}\n`).join(''), { append: true });
  }

  async loadCursor(teamId: string): Promise<WriterCursor | null> {
    const v = readJsonFile<unknown>(this.file(`cursor-${teamId}.json`));
    return isWriterCursor(v) ? v : null;
  }

  saveCursor(teamId: string, cursor: WriterCursor): void {
    writeJsonFile(this.file(`cursor-${teamId}.json`), cursor);
  }

  deleteTeam(teamId: string): void {
    for (const name of [`ops-${teamId}.jsonl`, `cursor-${teamId}.json`]) {
      const f = this.file(name);
      if (f.exists) f.delete();
    }
  }
}

/** Forget every simulated phone (Stop and reset). */
export function deleteSimDisks(): void {
  const dir = new Directory(Paths.document, SIM_ROOT);
  if (dir.exists) dir.delete();
}

/** The simulation's own small state file. */
export function simStateFile(): File {
  const dir = new Directory(Paths.document, SIM_ROOT);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return new File(dir, 'state.json');
}

export { readJsonFile, writeJsonFile };
