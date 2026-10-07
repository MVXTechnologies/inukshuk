import type { GpxWaypoint } from '@core/geo/gpx';
import type { LngLat } from '@core/models';

import { linkedPhotos, type LinkedPhoto } from './gpxZip';
import type { ImportCandidate } from './placement';

/**
 * Opening a "Trail + photos" zip (#587): which of its photos come back onto
 * the imported trail, and within what limits.
 *
 * Entry names are LOOKUP KEYS ONLY: they select which bytes to read from the
 * archive and are never used to build a path on the phone (each photo is
 * staged under a random name and re-encoded into the app's own copies). A
 * hostile archive is bounded by a per-photo size cap, a photo-count cap and
 * the import's shared decompression budget (`ByteBudget`).
 */

export interface ZipPhotoLimits {
  /** A single photo larger than this (uncompressed) is skipped. */
  maxPhotoBytes: number;
  /** At most this many photos per trail. */
  maxPhotos: number;
}

const MB = 1024 * 1024;

export const DEFAULT_ZIP_PHOTO_LIMITS: ZipPhotoLimits = {
  maxPhotoBytes: 25 * MB,
  maxPhotos: 500,
};

/** An archive entry, as the zip's central directory states it. */
export interface ZipEntryInfo {
  name: string;
  uncompressedSize: number;
}

export interface ZipPhotoAttach {
  /** Candidate key for placement (`zip-<n>`), never the entry name. */
  key: string;
  waypoint: GpxWaypoint;
  /** The archive entry to read (a lookup key, never a write path). */
  entryName: string;
  /** Declared uncompressed size (re-checked while reading). */
  declaredBytes: number;
}

export interface ZipPhotoPlan {
  attach: ZipPhotoAttach[];
  /** Linked photos left out: over the size cap, or past the count cap. */
  tooBig: number;
  overCount: number;
  /** The waypoints that are photos of this archive (kept out of trail notes). */
  photoWaypoints: Set<GpxWaypoint>;
}

/**
 * Pair a GPX's photo waypoints with the archive's image entries and apply the
 * caps. Waypoints linking to the same entry attach it once.
 */
export function planZipPhotoAttach(
  waypoints: readonly GpxWaypoint[],
  entries: readonly ZipEntryInfo[],
  limits: ZipPhotoLimits = DEFAULT_ZIP_PHOTO_LIMITS,
): ZipPhotoPlan {
  const sizes = new Map(entries.map((e) => [e.name, e.uncompressedSize]));
  const linked: LinkedPhoto[] = linkedPhotos(
    { waypoints: [...waypoints] },
    entries.map((e) => e.name),
  );
  const plan: ZipPhotoPlan = {
    attach: [],
    tooBig: 0,
    overCount: 0,
    photoWaypoints: new Set(linked.map((l) => l.waypoint)),
  };
  const seen = new Set<string>();
  for (const { waypoint, entryName } of linked) {
    if (seen.has(entryName)) continue;
    seen.add(entryName);
    const declaredBytes = sizes.get(entryName) ?? 0;
    if (declaredBytes > limits.maxPhotoBytes) {
      plan.tooBig++;
      continue;
    }
    if (plan.attach.length >= limits.maxPhotos) {
      plan.overCount++;
      continue;
    }
    plan.attach.push({ key: `zip-${plan.attach.length}`, waypoint, entryName, declaredBytes });
  }
  return plan;
}

/** The waypoints that should become trail notes: everything but the archive's photos. */
export function waypointsForNotes(
  waypoints: readonly GpxWaypoint[],
  photoWaypoints: ReadonlySet<GpxWaypoint>,
): GpxWaypoint[] {
  return waypoints.filter((w) => !photoWaypoints.has(w));
}

/** Where a photo waypoint says the photo was: its time and its position. */
export function zipPhotoCandidate(attach: ZipPhotoAttach): ImportCandidate {
  const { waypoint } = attach;
  const lngLat: LngLat = [waypoint.longitude, waypoint.latitude];
  const candidate: ImportCandidate = { key: attach.key, lngLat };
  if (waypoint.time !== undefined && Number.isFinite(waypoint.time)) {
    candidate.takenAt = waypoint.time;
  }
  return candidate;
}

/**
 * The caption a photo waypoint carries: its name, unless it is the export's
 * generic "Photo N" stand-in for an uncaptioned photo.
 */
export function zipPhotoCaption(waypoint: GpxWaypoint): string | undefined {
  const name = waypoint.name?.trim();
  if (!name || /^Photo \d+$/.test(name)) return undefined;
  return name;
}
