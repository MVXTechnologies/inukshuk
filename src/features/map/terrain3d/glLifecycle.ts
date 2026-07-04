import type { ExpoWebGLRenderingContext } from 'expo-gl';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';

/** Dispose every geometry, material and texture reachable from a group/scene. */
export function disposeGroup(g: THREE.Group): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.MeshStandardMaterial | undefined;
    if (mat) {
      mat.map?.dispose();
      mat.dispose();
    }
  });
}

/**
 * GL "generation" counter for a terrain GLView: bumped on every new context and
 * on unmount. A render loop re-queues itself only while its generation is
 * current — the GLView remounts (basemap change, recenter, 2D↔3D toggle), and
 * without this each remount stacked another permanent 60fps loop rendering a
 * retained multi-MB scene against a dead GL context.
 */
export function useGlGeneration() {
  const glGenRef = useRef(0);
  useEffect(
    () => () => {
      glGenRef.current++;
    },
    [],
  );
  return glGenRef;
}

export interface RenderLoopOptions {
  /** Whether this loop's GL generation is still the current one. */
  isCurrent: () => boolean;
  gl: ExpoWebGLRenderingContext;
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  /** Per-frame work (camera placement, marker updates) before the draw. */
  onFrame: () => void;
  /** Called once after a superseded scene/renderer is disposed (clear refs). */
  onDisposed?: () => void;
}

/**
 * Drive the per-frame render loop for a terrain GLView. The loop re-queues
 * itself only while `isCurrent()` holds (see {@link useGlGeneration}).
 */
export function runRenderLoop({
  isCurrent,
  gl,
  scene,
  camera,
  renderer,
  onFrame,
  onDisposed,
}: RenderLoopOptions): void {
  const render = () => {
    if (!isCurrent()) {
      // Superseded (unmount or GLView remount): stop the loop and free the
      // scene's GPU resources exactly once.
      disposeGroup(scene as unknown as THREE.Group);
      renderer.dispose();
      onDisposed?.();
      return;
    }
    requestAnimationFrame(render);
    onFrame();
    renderer.render(scene, camera);
    gl.endFrameEXP();
  };
  render();
}
