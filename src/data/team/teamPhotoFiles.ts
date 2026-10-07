/**
 * Teammates' shared photo thumbnails as files (#589 + #587), so the main map
 * can draw them with the trail-photo layers (round GL sprites, clustering)
 * like the user's own photos. Under `team-photos/<teamId>/`, deleted with the
 * team. Document-relative paths (the iOS container moves, #247).
 */
import { Directory, File } from 'expo-file-system';

import { resolveDocumentPath } from '@data/storage';

export const TEAM_PHOTOS_ROOT = 'team-photos';
const SAFE = /^[A-Za-z0-9_-]{1,64}$/;

export interface TeamPhotoPaths {
  thumb: string;
  sprite: string;
}

export function teamPhotoPaths(teamId: string, owner: string, id: string): TeamPhotoPaths | null {
  if (!SAFE.test(teamId) || !SAFE.test(owner) || !SAFE.test(id)) return null;
  const base = `${TEAM_PHOTOS_ROOT}/${teamId}/${owner}-${id}`;
  return { thumb: `${base}.jpg`, sprite: `${base}-s.png` };
}

const fileAt = (path: string) => new File(resolveDocumentPath(path));

export function teamPhotoFileExists(path: string): boolean {
  try {
    return fileAt(path).exists;
  } catch {
    return false;
  }
}

/** Write a base64 file (staged, then moved into place). */
export function writeTeamPhotoFile(path: string, base64: string): void {
  const dir = new Directory(resolveDocumentPath(path.slice(0, path.lastIndexOf('/'))));
  if (!dir.exists) dir.create({ intermediates: true });
  const staged = fileAt(`${path}.tmp`);
  if (staged.exists) staged.delete();
  staged.create();
  staged.write(base64, { encoding: 'base64' });
  staged.moveSync(fileAt(path), { overwrite: true });
}

export function teamPhotoUri(path: string): string {
  return resolveDocumentPath(path);
}

/** Forget a team's photo files (leaving or deleting the team). */
export function deleteTeamPhotoFiles(teamId: string): void {
  if (!SAFE.test(teamId)) return;
  try {
    const dir = new Directory(resolveDocumentPath(`${TEAM_PHOTOS_ROOT}/${teamId}`));
    if (dir.exists) dir.delete();
  } catch {
    // Already gone.
  }
}
