/**
 * A reference MapLibre camera: the projection matrix MapLibre Native hands a
 * custom layer (`CustomLayerRenderParameters.projectionMatrix`), rebuilt from
 * the camera's public parameters. On device the native renderers use
 * MapLibre's own matrix; this one lets the LOD/culling math be tested at
 * every pitch and bearing without a GPU, and is what the C++ parity fixtures
 * are generated from.
 *
 * The matrix maps (x_px, y_px, z_m, 1) — world pixels at the camera zoom
 * (x east, y SOUTH) and height in metres — to OpenGL clip space, with
 * screen-up = +y_ndc.
 */
import {
  dehomogenize,
  invert,
  multiply,
  perspective,
  scaling,
  transformVec4,
  type Mat4,
  type Vec3,
} from './mat4';
import { latToMercY, lngToMercX, pixelsPerMeter, worldSize } from './mercator';

/** MapLibre's default vertical field of view (`util::DEFAULT_FOV`, ≈ 36.87°). */
export const DEFAULT_FOV_RAD = 0.6435011087932844;

export interface CameraParams {
  lng: number;
  lat: number;
  zoom: number;
  /** Degrees from straight down (0 = top-down). */
  pitchDeg: number;
  /** Compass direction the top of the screen faces, degrees clockwise from north. */
  bearingDeg: number;
  /** Viewport in logical pixels. */
  width: number;
  height: number;
  fovRad?: number;
}

/** Camera-to-centre distance in pixels: `½·height / tan(fov/2)`. */
export function cameraToCenterDistance(height: number, fovRad = DEFAULT_FOV_RAD): number {
  return (0.5 * height) / Math.tan(fovRad / 2);
}

/** The centre of the view in world pixels at the camera zoom. */
export function centerPx(c: Pick<CameraParams, 'lng' | 'lat' | 'zoom'>): [number, number] {
  const ws = worldSize(c.zoom);
  return [lngToMercX(c.lng) * ws, latToMercY(c.lat) * ws];
}

/** MapLibre's far plane for a pitch (see `TransformState::getProjMatrix`). */
export function farPlane(ctc: number, pitchRad: number, fovRad: number): number {
  const limited = Math.min(Math.max(pitchRad, 0), (85 * Math.PI) / 180);
  const tanMultiple = Math.min(Math.max(Math.tan(fovRad / 2) * Math.tan(limited), 0), 0.99);
  return (ctc / (1 - tanMultiple)) * 1.01;
}

function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  let fx = target[0] - eye[0];
  let fy = target[1] - eye[1];
  let fz = target[2] - eye[2];
  const fl = Math.hypot(fx, fy, fz);
  fx /= fl;
  fy /= fl;
  fz /= fl;
  // s = f × up
  let sx = fy * up[2] - fz * up[1];
  let sy = fz * up[0] - fx * up[2];
  let sz = fx * up[1] - fy * up[0];
  const sl = Math.hypot(sx, sy, sz);
  sx /= sl;
  sy /= sl;
  sz /= sl;
  // u = s × f
  const ux = sy * fz - sz * fy;
  const uy = sz * fx - sx * fz;
  const uz = sx * fy - sy * fx;
  return [
    sx,
    ux,
    -fx,
    0,
    sy,
    uy,
    -fy,
    0,
    sz,
    uz,
    -fz,
    0,
    -(sx * eye[0] + sy * eye[1] + sz * eye[2]),
    -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
    fx * eye[0] + fy * eye[1] + fz * eye[2],
    1,
  ];
}

/**
 * The projection matrix for a camera. Internally the world is flipped to a
 * right-handed frame (x east, Y = −y north, z up in pixels) — the y flip and
 * the metres→pixels z scale are folded into the matrix.
 */
export function projectionMatrix(c: CameraParams): Mat4 {
  const fov = c.fovRad ?? DEFAULT_FOV_RAD;
  const pitch = (c.pitchDeg * Math.PI) / 180;
  const bearing = (c.bearingDeg * Math.PI) / 180;
  const ctc = cameraToCenterDistance(c.height, fov);
  const [cx, cy] = centerPx(c);
  const fX = Math.sin(bearing);
  const fY = Math.cos(bearing);
  const target: Vec3 = [cx, -cy, 0];
  const eye: Vec3 = [
    cx - fX * ctc * Math.sin(pitch),
    -cy - fY * ctc * Math.sin(pitch),
    ctc * Math.cos(pitch),
  ];
  // Screen-up: the forward direction tipped up by the pitch (straight down at
  // pitch 0 means "up" is the forward ground direction).
  const up: Vec3 = [fX * Math.cos(pitch), fY * Math.cos(pitch), Math.sin(pitch)];
  const view = lookAt(eye, target, up);
  const proj = perspective(fov, c.width / c.height, 1, farPlane(ctc, pitch, fov));
  const ppm = pixelsPerMeter(c.lat, c.zoom);
  // world (x, y_south, z_m) → right-handed pixels (x, −y, z·ppm)
  return multiply(multiply(proj, view), scaling(1, -1, ppm));
}

/**
 * The eye position in the matrix's own space (x_px, y_px, z_m), recovered
 * from any perspective projection: the eye is the point every view ray goes
 * through, which the projection sends to (0, 0, c, 0) — so it is
 * `P⁻¹·(0, 0, 1, 0)`, dehomogenised.
 */
export function eyeFromProjection(P: Mat4): Vec3 | null {
  const inv = invert(P);
  if (!inv) return null;
  return dehomogenize(transformVec4(inv, [0, 0, 1, 0]));
}

/** Project (x_px, y_px, z_m) to normalised device coordinates, or null behind the eye. */
export function projectToNdc(P: Mat4, x: number, y: number, z: number): Vec3 | null {
  const v = transformVec4(P, [x, y, z, 1]);
  if (v[3] <= 1e-9) return null;
  return [v[0] / v[3], v[1] / v[3], v[2] / v[3]];
}

/**
 * The ground point (z = `groundZ` metres) under a screen point given in NDC,
 * or null when the ray never reaches it (above the horizon).
 */
export function groundAtNdc(
  invP: Mat4,
  ndcX: number,
  ndcY: number,
  groundZ = 0,
): [number, number] | null {
  // z = 0 and 1 are in front of the eye in both the GL (−1..1) and the
  // Metal (0..1) clip conventions.
  const near = dehomogenize(transformVec4(invP, [ndcX, ndcY, 0, 1]));
  const far = dehomogenize(transformVec4(invP, [ndcX, ndcY, 1, 1]));
  if (!near || !far) return null;
  const dz = far[2] - near[2];
  if (Math.abs(dz) < 1e-12) return null;
  const s = (groundZ - near[2]) / dz;
  if (s < 0) return null;
  return [near[0] + (far[0] - near[0]) * s, near[1] + (far[1] - near[1]) * s];
}
