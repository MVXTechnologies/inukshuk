/** Throw a DOM-style AbortError when the import was cancelled. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
}
