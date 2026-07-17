import type { Basemap } from '@core/geo/tiles';
import type { TileRange } from '@core/geo/terrain';
import type { ExpoWebGLRenderingContext } from 'expo-gl';
import { Renderer } from 'expo-three';
import * as THREE from 'three';
import { fetchBasemapTexture, type BasemapTexture } from '../dem';
import { buildSkyDome } from './terrainMaterial';

/**
 * Sky-at-the-horizon colour: the sky dome's lowest gradient stop, and the fog
 * colour terrain fades into — keep the three in sync (SKY_STOPS.horizon in
 * @core/geo/terrainAnalysis) so the slab edge melts into the sky.
 */
export const SKY_COLOR = 0xdfe9f2;

/**
 * Add the gradient sky dome + matching horizon fog to a terrain scene. Fog
 * distances scale with the slab radius: the live view sits low in the terrain
 * (fog closes in fast for the hazy-horizon look); the trail view orbits from
 * further out, so its fog starts later or the whole trail would wash out.
 */
export function addSkyAndFog(
  scene: THREE.Scene,
  radius: number,
  nearMul: number,
  farMul: number,
): void {
  scene.fog = new THREE.Fog(SKY_COLOR, radius * nearMul, radius * farMul);
  scene.add(buildSkyDome());
}

/**
 * Create the expo-three renderer for a terrain GLView, sized to the drawing
 * buffer with the sky clear colour. Created before the terrain build so the
 * drape texture can use the GL context's max anisotropy and stay sharp at
 * grazing angles from the very first frame.
 */
export function createTerrainRenderer(gl: ExpoWebGLRenderingContext): {
  renderer: Renderer;
  maxAnisotropy: number;
} {
  const renderer = new Renderer({ gl });
  renderer.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight);
  renderer.setClearColor(SKY_COLOR, 1);
  return { renderer, maxAnisotropy: renderer.capabilities.getMaxAnisotropy() };
}

/** The perspective camera both terrain screens orbit with. */
export function createTerrainCamera(gl: ExpoWebGLRenderingContext): THREE.PerspectiveCamera {
  return new THREE.PerspectiveCamera(55, gl.drawingBufferWidth / gl.drawingBufferHeight, 0.01, 100);
}

/**
 * Warm key light from a low azimuth for stronger relief, plus a soft sky/
 * ground hemisphere fill so shadowed slopes keep some colour.
 */
export function addTerrainLights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xfff4e6, 0x55603f, 0.85));
  const sun = new THREE.DirectionalLight(0xfff2e0, 1.35);
  sun.position.set(2.2, 1.8, 1.0);
  scene.add(sun);
}

/**
 * A marker pin standing above the surface: a coloured sphere head on a thin
 * white pole. Colours and size differ per screen (live "you are here" vs trail
 * scrub highlight), so they're parameters.
 */
export function buildMarkerPin(opts: {
  headRadius: number;
  headColor: number;
  headEmissive: number;
  /** Pole height; the head sits at its top. */
  height: number;
}): THREE.Group {
  const marker = new THREE.Group();
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(opts.headRadius, 16, 16),
    new THREE.MeshStandardMaterial({ color: opts.headColor, emissive: opts.headEmissive }),
  );
  head.position.y = opts.height;
  // Pole thickness follows the head so small pins stay proportionate.
  const poleR = opts.headRadius * 0.2;
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(poleR, poleR, opts.height, 8),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x444444 }),
  );
  pole.position.y = opts.height / 2;
  marker.add(head, pole);
  return marker;
}

/**
 * Fetch the basemap drape texture for a heightmap's tile range. Returns
 * undefined for 'relief' (the mesh's hypsometric tint IS the relief look, no
 * drape) and on fetch failure (fall back to hypsometric relief).
 */
export async function fetchDrapeTexture(
  range: TileRange,
  basemap: Basemap,
): Promise<BasemapTexture | undefined> {
  if (basemap === 'relief') return undefined;
  try {
    return await fetchBasemapTexture(range, basemap);
  } catch {
    return undefined; // fall back to hypsometric relief
  }
}
