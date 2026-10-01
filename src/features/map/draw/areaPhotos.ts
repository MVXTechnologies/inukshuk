import * as storage from '@data/storage';
import * as ImagePicker from 'expo-image-picker';

/**
 * Pick a photo for an area (#503) — from the library or the camera, the same
 * picker settings and the same app-storage copy as a waypoint's photo — and
 * return the stored copy's uri, or null when the user backed out (or denied
 * the camera). Throws on a failed copy; the caller says so.
 */
export async function pickAreaPhoto(fromCamera: boolean): Promise<string | null> {
  if (fromCamera) {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return null;
  }
  const res = fromCamera
    ? await ImagePicker.launchCameraAsync({ quality: 0.6 })
    : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6 });
  const picked = res.canceled ? null : res.assets[0]?.uri;
  if (!picked) return null;
  return storage.importPhoto(picked, storage.newId());
}

/** Delete photo copies nothing will reference (a discarded draft's). Best effort. */
export function discardPhotos(uris: readonly string[]): void {
  for (const uri of uris) {
    try {
      storage.deleteFileAt(uri);
    } catch {
      // An orphan beats failing the action.
    }
  }
}
