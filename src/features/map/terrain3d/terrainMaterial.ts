import {
  autoContourInterval,
  hypsoRampRgba,
  SKY_STOPS,
  slopeRampRgba,
} from '@core/geo/terrainAnalysis';
import * as THREE from 'three';

/**
 * Shader-injected analytical overlays for the terrain mesh: CalTopo-style slope
 * bands, hypsometric tint bands, fwidth-anti-aliased contour lines and a subtle
 * rim light — all injected into the existing `MeshStandardMaterial` via
 * `onBeforeCompile` so lights/fog/texture handling stay stock.
 *
 * Every band computation in the GLSL below is a transcription of a tested TS
 * function in `@core/geo/terrainAnalysis` (`slopeBandColor` → uSlopeRamp,
 * `hypsoColor`/`hypsoBandStart` → uHypsoRamp, `contourStrength`,
 * `skyGradientColor`). Change them together.
 *
 * WebGL1 note: `fwidth()` needs OES_standard_derivatives; three r162 enables it
 * automatically for physical materials (MeshStandardMaterial), verified in the
 * 3D-TERRAIN-VISION plan. Callers must still guard with
 * {@link supportsStandardDerivatives} + {@link overlayRenderFailed} because
 * device-only shader failures are this repo's known blind spot.
 */

/** How many minor contour intervals make a major (bolder) line. */
export const CONTOUR_MAJOR_EVERY = 5;

/** Blend opacities when a layer is enabled (CalTopo draws bands at ~60–70%). */
const SLOPE_OPACITY = 0.62;
const HYPSO_OPACITY = 0.35;

export interface TerrainOverlayUniforms {
  uSlopeRamp: THREE.IUniform<THREE.Texture>;
  uHypsoRamp: THREE.IUniform<THREE.Texture>;
  uSlopeOpacity: THREE.IUniform<number>;
  uSlopeMinDeg: THREE.IUniform<number>;
  uHypsoOpacity: THREE.IUniform<number>;
  uContourOpacity: THREE.IUniform<number>;
  uContourInterval: THREE.IUniform<number>;
  uContourMajorEvery: THREE.IUniform<number>;
  uHypsoInterval: THREE.IUniform<number>;
  uMinH: THREE.IUniform<number>;
  uMaxH: THREE.IUniform<number>;
  uContourColor: THREE.IUniform<THREE.Color>;
  uRimColor: THREE.IUniform<THREE.Color>;
}

/** Live handle on an injected terrain material's overlay uniforms. */
export interface TerrainOverlayHandle {
  uniforms: TerrainOverlayUniforms;
  /** Elevation span of the heightmap, for the auto contour interval. */
  minH: number;
  maxH: number;
}

/** Which overlays are on, straight from the settings store. */
export interface TerrainOverlaySettings {
  slope: boolean;
  contours: boolean;
  hypso: boolean;
  /** Minor contour interval in metres; 0 = auto (span-based 10/25/50/100). */
  contourIntervalM: number;
  /** Lowest slope band drawn, in degrees (27 = every CalTopo band). */
  slopeMinDeg: number;
}

const VERT_DECLS = /* glsl */ `
attribute float aElevM;
attribute float aSlopeDeg;
varying float vElevM;
varying float vSlopeDeg;
`;

const VERT_ASSIGN = /* glsl */ `
vElevM = aElevM;
vSlopeDeg = aSlopeDeg;
`;

const FRAG_DECLS = /* glsl */ `
uniform sampler2D uSlopeRamp;
uniform sampler2D uHypsoRamp;
uniform float uSlopeOpacity;
uniform float uSlopeMinDeg;
uniform float uHypsoOpacity;
uniform float uContourOpacity;
uniform float uContourInterval;
uniform float uContourMajorEvery;
uniform float uHypsoInterval;
uniform float uMinH;
uniform float uMaxH;
uniform vec3 uContourColor;
uniform vec3 uRimColor;
varying float vElevM;
varying float vSlopeDeg;
`;

// Injected after <color_fragment>: diffuseColor is the drape (or hypsometric
// vertex tint); the overlays alpha-blend over it so terrain texture shows
// through — the FATMAP/CalTopo look.
const FRAG_OVERLAYS = /* glsl */ `
if (uHypsoOpacity > 0.0) {
  // Mirror of hypsoBandStart + hypsoColor: tint by the band's START elevation
  // so the tints read as flat "isobar-like" steps.
  float band = floor(vElevM / uHypsoInterval) * uHypsoInterval;
  float ht = clamp((band - uMinH) / max(uMaxH - uMinH, 1.0), 0.0, 1.0);
  vec3 hypso = texture2D(uHypsoRamp, vec2(ht, 0.5)).rgb;
  diffuseColor.rgb = mix(diffuseColor.rgb, hypso, uHypsoOpacity);
}
if (uSlopeOpacity > 0.0) {
  // Mirror of slopeBandColor via the 256×1 ramp (NEAREST → hard band edges).
  // step() hides bands under the slope-angle selector's floor (uSlopeMinDeg);
  // the 0.01 epsilon keeps a band's own floor value inside the band.
  vec4 slopeC = texture2D(uSlopeRamp, vec2(clamp(vSlopeDeg / 90.0, 0.0, 1.0), 0.5));
  float aboveFloor = step(uSlopeMinDeg - 0.01, vSlopeDeg);
  diffuseColor.rgb = mix(diffuseColor.rgb, slopeC.rgb, slopeC.a * uSlopeOpacity * aboveFloor);
}
if (uContourOpacity > 0.0) {
  // Mirror of contourStrength: fwidth-anti-aliased isolines with the minor
  // lines fading out as they approach aliasing density.
  float wpx = max(fwidth(vElevM), 1e-4);
  float dMinor = abs(fract(vElevM / uContourInterval - 0.5) - 0.5) * uContourInterval;
  float minorS = 1.0 - smoothstep(0.5 * wpx, 1.5 * wpx, dMinor);
  float majorI = uContourInterval * uContourMajorEvery;
  float dMajor = abs(fract(vElevM / majorI - 0.5) - 0.5) * majorI;
  float majorS = 1.0 - smoothstep(0.8 * wpx, 2.2 * wpx, dMajor);
  minorS *= 1.0 - smoothstep(0.25, 0.5, wpx / uContourInterval);
  float contourA = max(majorS * 0.55, minorS * 0.3) * uContourOpacity;
  diffuseColor.rgb = mix(diffuseColor.rgb, uContourColor, contourA);
}
`;

// Injected after <emissivemap_fragment>: `normal` and vViewPosition are in
// scope. A faint sky-coloured rim makes ridgelines glow against the horizon.
const FRAG_RIM = /* glsl */ `
{
  vec3 rimViewDir = normalize(vViewPosition);
  float rim = pow(1.0 - clamp(dot(normal, rimViewDir), 0.0, 1.0), 3.0);
  totalEmissiveRadiance += uRimColor * rim * 0.18;
}
`;

function rampTexture(ramp: Uint8Array, nearest: boolean): THREE.DataTexture {
  // Copy into a fresh ArrayBuffer-backed view (satisfies the DOM BufferSource
  // type — the core ramp builders return Uint8Array<ArrayBufferLike>).
  const rgba = new Uint8Array(ramp);
  const tex = new THREE.DataTexture(rgba, rgba.length / 4, 1, THREE.RGBAFormat);
  // Slope bands must stay hard-edged (NEAREST); the hypso ramp blends (LINEAR).
  tex.minFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  tex.magFilter = tex.minFilter;
  tex.needsUpdate = true;
  return tex;
}

export interface CreateTerrainMaterialOptions {
  /** Drape texture; omit for the hypsometric vertex-colour (relief) look. */
  map?: THREE.DataTexture;
  minH: number;
  maxH: number;
  /**
   * Inject the overlay shader. Pass false on devices without derivatives
   * support, or after {@link overlayRenderFailed} — the material then stays a
   * stock MeshStandardMaterial (overlays unavailable, everything else works).
   */
  inject: boolean;
}

/**
 * Build the terrain's MeshStandardMaterial, optionally injected with the
 * overlay shader. Ramp textures are registered in `material.userData
 * .overlayTextures` so `disposeGroup` can free them with the material.
 */
export function createTerrainMaterial(opts: CreateTerrainMaterialOptions): {
  material: THREE.MeshStandardMaterial;
  overlay: TerrainOverlayHandle | null;
} {
  const material = opts.map
    ? new THREE.MeshStandardMaterial({ map: opts.map, roughness: 1 })
    : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
  if (!opts.inject) return { material, overlay: null };

  const slopeTex = rampTexture(slopeRampRgba(), true);
  const hypsoTex = rampTexture(hypsoRampRgba(), false);
  const span = Math.max(opts.maxH - opts.minH, 1);
  const uniforms: TerrainOverlayUniforms = {
    uSlopeRamp: { value: slopeTex },
    uHypsoRamp: { value: hypsoTex },
    uSlopeOpacity: { value: 0 },
    uSlopeMinDeg: { value: 27 },
    uHypsoOpacity: { value: 0 },
    uContourOpacity: { value: 0 },
    uContourInterval: { value: autoContourInterval(span) },
    uContourMajorEvery: { value: CONTOUR_MAJOR_EVERY },
    uHypsoInterval: { value: autoContourInterval(span) * 2 },
    uMinH: { value: opts.minH },
    uMaxH: { value: opts.maxH },
    uContourColor: { value: new THREE.Color(0x4a3b2a) },
    uRimColor: { value: new THREE.Color(SKY_STOPS.mid[0], SKY_STOPS.mid[1], SKY_STOPS.mid[2]) },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECLS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_ASSIGN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_DECLS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_OVERLAYS}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_RIM}`);
  };
  // One stable cache key per injected variant (three still keys on map/vertex-
  // colour defines), so basemap switches reuse the compiled program.
  material.customProgramCacheKey = () => 'inukshuk-terrain-overlay-v2';
  material.userData.overlayTextures = [slopeTex, hypsoTex];

  return { material, overlay: { uniforms, minH: opts.minH, maxH: opts.maxH } };
}

/** Map the persisted settings onto a live overlay handle's uniforms. */
export function applyTerrainOverlaySettings(
  handle: TerrainOverlayHandle,
  s: TerrainOverlaySettings,
): void {
  const span = handle.maxH - handle.minH;
  const interval = s.contourIntervalM > 0 ? s.contourIntervalM : autoContourInterval(span);
  const u = handle.uniforms;
  u.uSlopeOpacity.value = s.slope ? SLOPE_OPACITY : 0;
  u.uSlopeMinDeg.value = s.slopeMinDeg;
  u.uHypsoOpacity.value = s.hypso ? HYPSO_OPACITY : 0;
  u.uContourOpacity.value = s.contours ? 1 : 0;
  u.uContourInterval.value = interval;
  u.uHypsoInterval.value = Math.max(interval * 2, 50);
}

/**
 * Whether `fwidth()` is available: core in WebGL2, an extension in WebGL1.
 * (three auto-injects the #extension line for physical materials; this guards
 * drivers that don't expose the extension at all.)
 */
export function supportsStandardDerivatives(
  gl: { getExtension: (name: string) => unknown },
  isWebGL2: boolean,
): boolean {
  if (isWebGL2) return true;
  try {
    return gl.getExtension('OES_standard_derivatives') != null;
  } catch {
    return false;
  }
}

/**
 * True when any compiled program in the renderer failed to link. three r162
 * does NOT throw on shader compile errors — it logs and stores a `diagnostics`
 * object on the failed program — so a try/catch alone can't catch device-only
 * GLSL failures. Call after a first render (compilation is lazy).
 */
export function rendererHasShaderError(renderer: THREE.WebGLRenderer): boolean {
  const programs = renderer.info.programs;
  if (!programs) return false;
  return programs.some((p) => {
    const diag = (p as { diagnostics?: { runnable?: boolean } }).diagnostics;
    return diag !== undefined && diag.runnable === false;
  });
}

/**
 * Render one guarded frame and report whether the injected overlay shader
 * failed (thrown error OR a program that compiled but can't run). On `true`,
 * rebuild the terrain with `inject: false` and render without overlays.
 */
export function overlayRenderFailed(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): boolean {
  try {
    renderer.render(scene, camera);
  } catch {
    return true;
  }
  return rendererHasShaderError(renderer);
}

/** Sky dome radius (scene units; slab spans ~2, camera far is 100). */
const SKY_DOME_RADIUS = 60;

const SKY_VERT = /* glsl */ `
varying float vY;
void main() {
  vY = normalize(position).y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Transcription of skyGradientColor (terrainAnalysis.ts).
const SKY_FRAG = /* glsl */ `
uniform vec3 uHorizon;
uniform vec3 uMid;
uniform vec3 uZenith;
varying float vY;
void main() {
  vec3 c = mix(uHorizon, uMid, smoothstep(0.02, 0.22, vY));
  c = mix(c, uZenith, smoothstep(0.22, 0.65, vY));
  gl_FragColor = vec4(c, 1.0);
}
`;

/**
 * Gradient sky dome: an inverted sphere with a 3-stop vertical gradient
 * (horizon haze → zenith blue). Drawn behind everything (depthWrite off),
 * unaffected by scene fog — the fog colour is tuned to the horizon stop so
 * terrain fades seamlessly into the dome.
 */
export function buildSkyDome(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(SKY_DOME_RADIUS, 24, 12);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uHorizon: { value: new THREE.Vector3(...SKY_STOPS.horizon) },
      uMid: { value: new THREE.Vector3(...SKY_STOPS.mid) },
      uZenith: { value: new THREE.Vector3(...SKY_STOPS.zenith) },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  return new THREE.Mesh(geo, mat);
}
