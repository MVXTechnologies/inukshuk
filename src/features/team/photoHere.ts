/**
 * "Photo here" (#589, owner 2026-10-07): take or choose a photo and anchor it
 * at the tapped spot (a trail point or a map point), not by its EXIF time. The
 * EXIF time stays as metadata; when the photo's own GPS is far from the spot,
 * the user chooses where it goes. The team gets the anchor and a 240 px
 * thumbnail re-encoded by the photo resizer (no EXIF, no GPS), as a shared
 * `photo` record: it shows as a photo bubble there, notifies per the rules,
 * and syncs later when offline (it is an ordinary signed op).
 */
import { normalizeExif } from '@core/photos/exif';
import { MAX_THUMB_B64 } from '@core/teamui/comments';
import type { TeamSession } from '@data/team/teamSession';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from 'react-native';

import { photoResizer } from '../photos/photoResizer';

function metresBetween(a: readonly [number, number], b: readonly [number, number]): number {
  const r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r;
  const dLng = (b[0] - a[0]) * r;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Further than this from the spot, the photo's own place is offered too. */
const FAR_M = 150;

function choose(title: string, message: string, a: string, b: string): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: a, onPress: () => resolve(true) },
      { text: b, onPress: () => resolve(false) },
    ]),
  );
}

/** Pick (camera or library) and share a photo at `at`. Null when done or backed out; else an error. */
export async function photoHere(
  session: TeamSession,
  at: [number, number],
  trackId: string | null,
  fromCamera: boolean,
): Promise<string | null> {
  if (fromCamera) {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return 'The camera is off for Inukshuk (Settings).';
  }
  const res = fromCamera
    ? await ImagePicker.launchCameraAsync({ quality: 0.8, exif: true })
    : await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.8,
        exif: true,
      });
  const asset = res.canceled ? undefined : res.assets[0];
  if (!asset) return null;
  const exif = normalizeExif(asset.exif ?? null);
  let place = at;
  if (exif.lngLat) {
    const d = metresBetween(at, exif.lngLat);
    if (d > FAR_M) {
      const here = await choose(
        'Where does it go?',
        `It was taken ${d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`} from this spot.`,
        'Place it here',
        'Where it was taken',
      );
      if (!here) place = [exif.lngLat[0], exif.lngLat[1]];
    }
  }
  const takenAt =
    exif.time?.kind === 'absolute'
      ? exif.time.epochMs
      : exif.time?.kind === 'local'
        ? exif.time.wallMs
        : Date.now();
  let thumb: string;
  let width = asset.width;
  let height = asset.height;
  try {
    const out = await photoResizer.resize(asset.uri);
    thumb = out.thumb.base64;
    width = out.display.width;
    height = out.display.height;
  } catch {
    return 'The photo could not be prepared.';
  }
  const id = session.newId();
  const err = session.writeEntity('photo', id, {
    trackId: trackId ?? 'spot',
    lngLat: [place[0], place[1]],
    placement: 'gps',
    takenAt,
    width,
    height,
    distanceM: 0,
  });
  if (err) return 'Not shared: the team is busy, try again.';
  if (thumb.length <= MAX_THUMB_B64) session.writeEntity('photo', id, { tb: thumb });
  return null;
}
