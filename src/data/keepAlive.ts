/**
 * Keep an expo-file-system object (a `File`, a `Directory`) reachable until an
 * async call on it settles: `await keepAlive(file, file.text())`.
 *
 * Its async methods (`text`, `base64`, `bytes`) convert `this` on the native
 * side only when the call runs. When the call is the object's last use
 * (`new File(uri).base64()`, `return file.text()`), Hermes may collect the JS
 * object first, expo releases its native half, and the call rejects with
 * ERR_USING_RELEASED_SHARED_OBJECT ("Cannot use shared object that was
 * already released"). Seen on the CI emulator (E2E run 37792234175): the map's
 * pdf.js assets failed to load, so no PDF map drew.
 */
const pinned = new Set<{ readonly target: object }>();

export async function keepAlive<T>(target: object, work: Promise<T>): Promise<T> {
  const pin = { target };
  pinned.add(pin);
  try {
    return await work;
  } finally {
    pinned.delete(pin);
  }
}

/** How many calls are holding their object right now (for tests). */
export function keptAliveCount(): number {
  return pinned.size;
}
