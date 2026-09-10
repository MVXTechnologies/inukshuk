import { useReparseStoredMaps } from './useReparseStoredMaps';

/**
 * Renders nothing; hosts the once-per-launch re-parse of stored maps whose
 * georeferencing predates the current parser (#336). Mount once at the root,
 * next to the other background services.
 */
export function MapReparseWorker(): null {
  useReparseStoredMaps();
  return null;
}
