import type { LngLat, TrackPoint } from '@core/models';

import type { TrackPhoto } from './model';
import { choosePass } from './placement';
import { newTrackPhoto } from './record';
import { orderPhotos } from './stack';
import {
  indexTrack,
  passesNear,
  positionAtDistance,
  positionAtTime,
  type TrailPosition,
} from './trackIndex';

/**
 * Photos taken with the recording panel's Photo button (#587, DESIGN §4.1).
 *
 * While recording, a photo is a {@link PendingPhoto}: its copies are already
 * written under `photos/<sessionId>/` (the folder that becomes the saved
 * trail's), and its record rides the recorder's crash checkpoint. On stop it
 * becomes a {@link TrackPhoto} placed by its capture time on the final trail.
 */
export interface PendingPhoto {
  id: string;
  /** Device clock at capture, epoch ms. */
  takenAt: number;
  /** The live fix at capture (the map circle while recording). */
  lngLat: LngLat;
  /** The recorder's distance at capture (the snackbar's "2.40 km"). */
  distanceM: number;
  elevationM?: number;
  /** Document-relative copies, as written. */
  file: string;
  thumb: string;
  sprite: string;
  width: number;
  height: number;
  bytes: number;
  contentHash?: string;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPath = (v: unknown): v is string => typeof v === 'string' && v !== '' && !v.includes('..');

/** Validate pending photos read back from a checkpoint (junk entries are dropped). */
export function sanitizePendingPhotos(raw: unknown): PendingPhoto[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingPhoto[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const ll = r['lngLat'];
    if (
      typeof r['id'] !== 'string' ||
      r['id'] === '' ||
      !isFiniteNumber(r['takenAt']) ||
      !isFiniteNumber(r['distanceM']) ||
      !Array.isArray(ll) ||
      ll.length !== 2 ||
      !isFiniteNumber(ll[0]) ||
      !isFiniteNumber(ll[1]) ||
      !isPath(r['file']) ||
      !isPath(r['thumb']) ||
      !isPath(r['sprite'])
    ) {
      continue;
    }
    const p: PendingPhoto = {
      id: r['id'],
      takenAt: r['takenAt'],
      lngLat: [ll[0], ll[1]],
      distanceM: Math.max(0, r['distanceM']),
      file: r['file'],
      thumb: r['thumb'],
      sprite: r['sprite'],
      width: isFiniteNumber(r['width']) ? r['width'] : 0,
      height: isFiniteNumber(r['height']) ? r['height'] : 0,
      bytes: isFiniteNumber(r['bytes']) ? r['bytes'] : 0,
    };
    if (isFiniteNumber(r['elevationM'])) p.elevationM = r['elevationM'];
    if (typeof r['contentHash'] === 'string' && r['contentHash'] !== '') {
      p.contentHash = r['contentHash'];
    }
    out.push(p);
  }
  return out;
}

/** Where a captured photo goes on the saved trail: its capture time, else its fix, else the end. */
function placeCaptured(
  index: ReturnType<typeof indexTrack>,
  p: PendingPhoto,
): TrailPosition | null {
  const byTime = positionAtTime(index, p.takenAt);
  if (byTime) return byTime;
  const pass = choosePass(index, passesNear(index, p.lngLat, 200), p.takenAt);
  if (pass) {
    const { offTrackM: _off, ...position } = pass;
    return position;
  }
  return positionAtDistance(index, index.totalM);
}

/**
 * The saved trail's photos from the session's pending ones: placement
 * `capture`, time source `capture`, each placed on the final points by its
 * capture time (clamped onto the trail).
 */
export function materializePendingPhotos(
  pending: readonly PendingPhoto[],
  trackId: string,
  points: readonly TrackPoint[],
  now: number,
): TrackPhoto[] {
  if (pending.length === 0) return [];
  const index = indexTrack(points);
  const out: TrackPhoto[] = [];
  for (const p of pending) {
    const position = placeCaptured(index, p);
    if (!position) continue;
    const input: Parameters<typeof newTrackPhoto>[0] = {
      id: p.id,
      trackId,
      position,
      placement: 'capture',
      takenAt: p.takenAt,
      takenAtSource: 'capture',
      paths: { file: p.file, thumb: p.thumb, sprite: p.sprite },
      width: p.width,
      height: p.height,
      bytes: p.bytes,
      now,
    };
    if (p.contentHash) input.contentHash = p.contentHash;
    out.push(newTrackPhoto(input));
  }
  return orderPhotos(out);
}

/** Pending photos drawn as trail photos on the live map (circles on the orange line). */
export function pendingAsTrackPhotos(
  pending: readonly PendingPhoto[],
  sessionId: string,
): TrackPhoto[] {
  return pending.map((p) => {
    const photo: TrackPhoto = {
      id: p.id,
      trackId: sessionId,
      distanceM: p.distanceM,
      lngLat: p.lngLat,
      placement: 'capture',
      takenAt: p.takenAt,
      takenAtSource: 'capture',
      file: p.file,
      thumb: p.thumb,
      sprite: p.sprite,
      width: p.width,
      height: p.height,
      bytes: p.bytes,
      createdAt: p.takenAt,
      updatedAt: p.takenAt,
    };
    if (p.elevationM !== undefined) photo.elevationM = p.elevationM;
    return photo;
  });
}

/**
 * The snackbar after a capture: "Photo 7 added to this recording", then
 * "2.40 km · 732 m · 10:10" from already-formatted parts (blank parts skipped).
 */
export function captureToastText(
  n: number,
  parts: readonly (string | null | undefined)[],
): { title: string; detail: string } {
  return {
    title: `Photo ${n} added to this recording`,
    detail: parts.filter((s): s is string => typeof s === 'string' && s !== '').join(' · '),
  };
}

/** The Photo button's accessibility label: "Take a photo", with the count when there are some. */
export function photoButtonLabel(count: number): string {
  if (count <= 0) return 'Take a photo';
  return `Take a photo, ${count} ${count === 1 ? 'photo' : 'photos'} so far`;
}
