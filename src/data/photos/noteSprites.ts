import { Directory, File, Paths } from 'expo-file-system';

import { noteSpriteName } from '@core/photos/notePins';

import type { PhotoResizer } from './resizer';

/**
 * Round map sprites for note photos (#742): the trail photos' 264 px circle,
 * made once per note photo by the photo resizer and kept in the cache
 * directory (the OS may purge it; it is simply made again). Never the
 * full-size photo on the map.
 */

const DIR = 'note-sprites';

function spriteFile(photoUri: string): File {
  return new File(new Directory(Paths.cache, DIR), noteSpriteName(photoUri));
}

/** The cached sprite's `file://` uri, or null when it has not been made. */
export function cachedNoteSprite(photoUri: string): string | null {
  try {
    const f = spriteFile(photoUri);
    return f.exists && (f.size ?? 0) > 0 ? f.uri : null;
  } catch {
    return null;
  }
}

/** Make (or re-make) a note photo's sprite; resolves to its `file://` uri. */
export async function makeNoteSprite(photoUri: string, resizer: PhotoResizer): Promise<string> {
  const out = await resizer.resize(photoUri);
  const dir = new Directory(Paths.cache, DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  const f = spriteFile(photoUri);
  if (f.exists) f.delete();
  f.create();
  f.write(out.sprite.base64, { encoding: 'base64' });
  return f.uri;
}
