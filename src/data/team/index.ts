import { LoopbackMeshHub, type LoopbackMeshTransport } from './loopbackMesh';
import { createNativeMeshTransport } from './meshNative';
import type { MeshTransport } from './meshTransport';

export * from './meshTransport';
export { MeshSessionHost } from './meshSessions';
export type { FrameSession, FrameStep, SessionFactory, SessionHostOptions } from './meshSessions';
export { LoopbackMeshHub, LoopbackMeshTransport } from './loopbackMesh';
export { createNativeMeshTransport, nativeMeshAvailable } from './meshNative';

/**
 * `EXPO_PUBLIC_MESH_LOOPBACK=1` (dev and E2E builds only) swaps the native
 * transport for the in-memory hub, so the team UI and Maestro can run two
 * simulated peers in one app. Inlined at build time: a store build never
 * sets it.
 */
export const MESH_LOOPBACK = process.env.EXPO_PUBLIC_MESH_LOOPBACK === '1';

let loopbackHub: LoopbackMeshHub | null = null;

/** The shared in-memory hub (loopback builds): add simulated peers with `createTransport()`. */
export function sharedLoopbackHub(): LoopbackMeshHub {
  loopbackHub ??= new LoopbackMeshHub();
  return loopbackHub;
}

let selected: MeshTransport | null | undefined;

/** This app's mesh transport, or null when the binary has no mesh module. */
export function selectMeshTransport(): MeshTransport | null {
  if (selected !== undefined) return selected;
  selected = MESH_LOOPBACK
    ? (sharedLoopbackHub().createTransport() as LoopbackMeshTransport)
    : createNativeMeshTransport();
  return selected;
}
