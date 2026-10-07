import type { TrackPhoto } from '@core/photos/model';
import { shareableJpeg } from '@core/photos/shareable';
import {
  createCacheFileWriter,
  deleteFileAt,
  readFileBytes,
  resolveDocumentPath,
} from '@data/storage';
import { uuid } from 'expo-modules-core';

/**
 * One photo, ready for the share sheet (#587, the viewer's Share): its
 * display copy when that carries no metadata, else a stripped copy in the
 * cache (named by a random uuid, never by the photo). Call `dispose` after
 * the share sheet closes. Throws when the file is not a JPEG whose metadata
 * can be checked: such a file is never shared.
 */
export interface ShareablePhoto {
  uri: string;
  dispose: () => void;
}

export class UnshareablePhotoError extends Error {
  constructor() {
    super("This photo can't be shared: its location data could not be checked");
    this.name = 'UnshareablePhotoError';
  }
}

const noop = () => undefined;

export async function shareablePhotoUri(photo: Pick<TrackPhoto, 'file'>): Promise<ShareablePhoto> {
  const bytes = await readFileBytes(photo.file);
  const checked = shareableJpeg(bytes);
  if (checked.kind === 'unreadable') throw new UnshareablePhotoError();
  if (checked.kind === 'clean') return { uri: resolveDocumentPath(photo.file), dispose: noop };
  const writer = createCacheFileWriter(`${uuid.v4()}.jpg`);
  try {
    writer.write(checked.bytes);
    writer.close();
  } catch (err) {
    try {
      writer.close();
      deleteFileAt(writer.uri);
    } catch {
      // best effort
    }
    throw err;
  }
  return {
    uri: writer.uri,
    dispose: () => {
      try {
        deleteFileAt(writer.uri);
      } catch {
        // The cache: the OS reclaims it.
      }
    },
  };
}
