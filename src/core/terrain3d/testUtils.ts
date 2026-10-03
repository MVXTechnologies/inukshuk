/** Test-only helpers for the terrain3d suites (excluded from coverage). */
import { DEFAULT_FOV_RAD, projectionMatrix, type CameraParams } from './camera';
import type { FrameCamera } from './lod';

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The QA places (lng, lat, a typical hiking zoom). */
export const PLACES = {
  zermatt: { lng: 7.7491, lat: 46.0207, zoom: 13 },
  chamonix: { lng: 6.8694, lat: 45.9237, zoom: 13 },
  montSainteAnne: { lng: -70.9067, lat: 47.0756, zoom: 14 },
  grandCanyon: { lng: -112.1129, lat: 36.1069, zoom: 12.5 },
  yosemite: { lng: -119.5383, lat: 37.7456, zoom: 13 },
} as const;

export type PlaceName = keyof typeof PLACES;

export function camera(
  place: { lng: number; lat: number; zoom: number },
  pitchDeg: number,
  bearingDeg: number,
  width = 412,
  height = 892,
): CameraParams {
  return { ...place, pitchDeg, bearingDeg, width, height, fovRad: DEFAULT_FOV_RAD };
}

export function frameCamera(c: CameraParams): FrameCamera {
  return {
    P: projectionMatrix(c),
    width: c.width,
    height: c.height,
    fovRad: c.fovRad ?? DEFAULT_FOV_RAD,
    zoom: c.zoom,
    lat: c.lat,
  };
}
