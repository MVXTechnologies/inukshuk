import { reportError } from '@lib/errorReporting';
import { GLView, type GLViewProps, type ExpoWebGLRenderingContext } from 'expo-gl';
import { createElement, useCallback, useLayoutEffect, useRef } from 'react';
import * as THREE from 'three';

/** One failed native release must not strand other resources or mask a frame error. */
function safelyDispose(cleanup: () => void): void {
  try {
    cleanup();
  } catch (error) {
    reportError(error, 'terrain3d-cleanup');
  }
}

/** Dispose every geometry, material and texture reachable from a group/scene. */
export function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) safelyDispose(() => m.geometry.dispose());
    const mat = m.material as THREE.MeshStandardMaterial | undefined;
    if (mat) {
      if (mat.map) safelyDispose(() => mat.map?.dispose());
      // Overlay ramp textures (terrain3d/terrainMaterial.ts) ride along in
      // userData because uniforms aren't reachable from a stock material.
      const extra = mat.userData?.overlayTextures as THREE.Texture[] | undefined;
      if (extra) for (const t of extra) safelyDispose(() => t.dispose());
      safelyDispose(() => mat.dispose());
    }
  });
}

/** Resources belonging to one native GL context, including pending async work. */
export interface GlLifetime {
  isCurrent: () => boolean;
  onDispose: (cleanup: () => void) => void;
  dispose: () => void;
}

function createGlLifetime(): GlLifetime {
  let current = true;
  const cleanups: (() => void)[] = [];
  return {
    isCurrent: () => current,
    onDispose: (cleanup) => {
      if (current) cleanups.push(cleanup);
      else safelyDispose(cleanup);
    },
    dispose: () => {
      if (!current) return;
      current = false;
      // Cancel the loop before releasing resources registered during loading.
      for (const cleanup of cleanups.splice(0).reverse()) safelyDispose(cleanup);
    },
  };
}

/** The disposal boundary follows the actual GL child, including keyed remounts. */
export function ManagedGLView({
  onContextCreate,
  ...props
}: Omit<GLViewProps, 'onContextCreate'> & {
  onContextCreate: (gl: ExpoWebGLRenderingContext, lifetime: GlLifetime) => void;
}) {
  const lifetimeRef = useRef<GlLifetime | null>(null);
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lifetimeRef.current?.dispose();
    };
  }, []);
  const handleContextCreate = useCallback(
    (gl: ExpoWebGLRenderingContext) => {
      if (!mountedRef.current) return;
      lifetimeRef.current?.dispose();
      const lifetime = createGlLifetime();
      lifetimeRef.current = lifetime;
      onContextCreate(gl, lifetime);
    },
    [onContextCreate],
  );
  // This native event callback runs after commit; createElement does not invoke it.
  // eslint-disable-next-line react-hooks/refs
  return createElement(GLView, { ...props, onContextCreate: handleContextCreate });
}

export interface RenderLoopOptions {
  lifetime: GlLifetime;
  gl: ExpoWebGLRenderingContext;
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  /** Per-frame work (camera placement, marker updates) before the draw. */
  onFrame: () => void;
  onError?: (error: unknown) => void;
}

/**
 * Drive the per-frame render loop for a terrain GLView. The loop re-queues
 * itself only while its native context is current. Resources are registered
 * with the lifetime by their owner immediately after creation.
 */
export function runRenderLoop({
  lifetime,
  gl,
  scene,
  camera,
  renderer,
  onFrame,
  onError,
}: RenderLoopOptions): void {
  let frameId: number | undefined;
  lifetime.onDispose(() => {
    if (frameId !== undefined) cancelAnimationFrame(frameId);
  });
  const render = () => {
    if (!lifetime.isCurrent()) return;
    try {
      onFrame();
      if (!lifetime.isCurrent()) return;
      renderer.render(scene, camera);
      gl.endFrameEXP();
      frameId = requestAnimationFrame(render);
    } catch (error) {
      lifetime.dispose();
      if (onError) onError(error);
      else throw error;
    }
  };
  render();
}
