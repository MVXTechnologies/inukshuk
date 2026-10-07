/**
 * The app's one `TeamService` (#589): noble crypto on the native CSPRNG, the
 * file-system + secure-store disk, and the mesh transport this build has
 * (native, or the loopback hub under `EXPO_PUBLIC_MESH_LOOPBACK=1`).
 *
 * `null` when this binary lacks any of the three native pieces (an OTA onto
 * a build older than 2.5.0): the extension then says it needs the update.
 */
import { secureStoreAvailable } from '@data/secureStore';

import { fsTeamDisk } from './fsTeamDisk';
import { selectMeshTransport } from './index';
import { teamCrypto } from './teamCrypto';
import { TeamService } from './teamService';

let service: TeamService | null | undefined;

export type TeamAvailability = 'ok' | 'needs-update';

export function teamAvailability(): TeamAvailability {
  return appTeamService() === null ? 'needs-update' : 'ok';
}

export function appTeamService(): TeamService | null {
  if (service !== undefined) return service;
  const c = teamCrypto();
  const transport = selectMeshTransport();
  service =
    c === null || transport === null || !secureStoreAvailable()
      ? null
      : new TeamService({ c, disk: fsTeamDisk, transport });
  return service;
}

/** Test-only. */
export function resetAppTeamServiceForTests(next?: TeamService | null): void {
  service = next;
}
