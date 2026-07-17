import * as THREE from 'three';
import type { Heightmap } from '../dem';
import { buildTerrain } from '../terrainScene';
import {
  applyTerrainOverlaySettings,
  buildSkyDome,
  createTerrainMaterial,
  rendererHasShaderError,
  supportsStandardDerivatives,
} from './terrainMaterial';

/**
 * The overlay shader is injected by string-replacing chunk markers in three's
 * physical shader. If a chunk name drifts in the pinned three build (or a
 * refactor typos one), the replacement silently no-ops and the overlays just
 * don't draw — ON DEVICE ONLY. This suite runs the injection against the REAL
 * shader sources from the pinned three, so that failure mode breaks CI instead.
 */

function rampHm(grid = 8): Heightmap {
  return {
    data: new Float32Array(grid * grid).map((_, i) => 100 + (i % grid) * 30),
    grid,
    bbox: { minLng: -73.62, maxLng: -73.5, minLat: 45.5, maxLat: 45.6 },
    range: { z: 14, minX: 0, maxX: 1, minY: 0, maxY: 1 },
    minH: 100,
    maxH: 100 + (grid - 1) * 30,
  };
}

function injectedShader(material: THREE.MeshStandardMaterial) {
  const shader = {
    uniforms: {} as Record<string, unknown>,
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  };
  material.onBeforeCompile(shader as never, null as never);
  return shader;
}

describe('terrain overlay shader injection (against the pinned three build)', () => {
  const build = () => {
    const grid = 8;
    const tex = { data: new Uint8Array(grid * grid * 4).fill(180), width: grid, height: grid };
    const b = buildTerrain(rampHm(grid), [], tex, 1);
    const mesh = b.group.children[0] as THREE.Mesh;
    return { build: b, material: mesh.material as THREE.MeshStandardMaterial };
  };

  it('every chunk marker matches: attributes, overlays, rim light all land', () => {
    const { material } = build();
    const shader = injectedShader(material);
    // Vertex: attributes declared + varyings assigned.
    expect(shader.vertexShader).toContain('attribute float aElevM');
    expect(shader.vertexShader).toContain('vElevM = aElevM');
    expect(shader.vertexShader).not.toBe(THREE.ShaderLib.physical.vertexShader);
    // Fragment: overlay mixes after <color_fragment>, rim into the emissive term.
    expect(shader.fragmentShader).toContain('uniform sampler2D uSlopeRamp');
    expect(shader.fragmentShader).toContain('fwidth(vElevM)');
    expect(shader.fragmentShader).toContain('totalEmissiveRadiance += uRimColor');
    expect(shader.fragmentShader).not.toBe(THREE.ShaderLib.physical.fragmentShader);
  });

  it('wires the overlay uniforms into the program', () => {
    const { material } = build();
    const shader = injectedShader(material);
    for (const k of [
      'uSlopeRamp',
      'uHypsoRamp',
      'uSlopeOpacity',
      'uHypsoOpacity',
      'uContourOpacity',
      'uContourInterval',
      'uContourMajorEvery',
      'uHypsoInterval',
      'uMinH',
      'uMaxH',
      'uContourColor',
      'uRimColor',
    ])
      expect(shader.uniforms[k]).toBeDefined();
  });

  it('keeps braces balanced in both injected sources (GLSL sanity)', () => {
    const { material } = build();
    const shader = injectedShader(material);
    for (const src of [shader.vertexShader, shader.fragmentShader]) {
      expect((src.match(/{/g) ?? []).length).toBe((src.match(/}/g) ?? []).length);
    }
  });

  it('registers the ramp textures for disposal and a stable program cache key', () => {
    const { material } = build();
    expect(material.userData.overlayTextures).toHaveLength(2);
    expect(material.customProgramCacheKey()).toBe('inukshuk-terrain-overlay-v1');
  });
});

describe('applyTerrainOverlaySettings', () => {
  const handle = () => createTerrainMaterial({ minH: 200, maxH: 700, inject: true }).overlay!; // span 500

  it('maps toggles to opacities', () => {
    const h = handle();
    applyTerrainOverlaySettings(h, {
      slope: true,
      contours: true,
      hypso: true,
      contourIntervalM: 0,
    });
    expect(h.uniforms.uSlopeOpacity.value).toBeGreaterThan(0);
    expect(h.uniforms.uHypsoOpacity.value).toBeGreaterThan(0);
    expect(h.uniforms.uContourOpacity.value).toBe(1);
    applyTerrainOverlaySettings(h, {
      slope: false,
      contours: false,
      hypso: false,
      contourIntervalM: 0,
    });
    expect(h.uniforms.uSlopeOpacity.value).toBe(0);
    expect(h.uniforms.uHypsoOpacity.value).toBe(0);
    expect(h.uniforms.uContourOpacity.value).toBe(0);
  });

  it('auto interval derives from the elevation span; manual wins', () => {
    const h = handle();
    applyTerrainOverlaySettings(h, {
      slope: false,
      contours: true,
      hypso: false,
      contourIntervalM: 0,
    });
    expect(h.uniforms.uContourInterval.value).toBe(25); // span 500 → 25 m
    applyTerrainOverlaySettings(h, {
      slope: false,
      contours: true,
      hypso: false,
      contourIntervalM: 100,
    });
    expect(h.uniforms.uContourInterval.value).toBe(100);
  });
});

describe('runtime guards', () => {
  it('supportsStandardDerivatives: WebGL2 always, else the extension decides', () => {
    expect(supportsStandardDerivatives({ getExtension: () => null }, true)).toBe(true);
    expect(supportsStandardDerivatives({ getExtension: () => ({}) }, false)).toBe(true);
    expect(supportsStandardDerivatives({ getExtension: () => null }, false)).toBe(false);
    expect(
      supportsStandardDerivatives(
        {
          getExtension: () => {
            throw new Error('boom');
          },
        },
        false,
      ),
    ).toBe(false);
  });

  it('rendererHasShaderError reads three program diagnostics', () => {
    const fake = (programs: unknown) => ({ info: { programs } }) as unknown as THREE.WebGLRenderer;
    expect(rendererHasShaderError(fake(null))).toBe(false);
    expect(rendererHasShaderError(fake([{}]))).toBe(false);
    expect(rendererHasShaderError(fake([{ diagnostics: { runnable: true } }]))).toBe(false);
    expect(rendererHasShaderError(fake([{ diagnostics: { runnable: false } }]))).toBe(true);
  });
});

describe('buildSkyDome', () => {
  it('is an inward-facing, fog-immune dome drawn behind everything', () => {
    const dome = buildSkyDome();
    const mat = dome.material as THREE.ShaderMaterial;
    expect(mat.side).toBe(THREE.BackSide);
    expect(mat.depthWrite).toBe(false);
    expect(mat.fog).toBe(false);
    // The gradient is the transcription of skyGradientColor: 3 stops wired in.
    for (const k of ['uHorizon', 'uMid', 'uZenith']) expect(mat.uniforms[k]).toBeDefined();
  });
});
