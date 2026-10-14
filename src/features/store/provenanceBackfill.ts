import { provenanceBackfill } from '@core/catalog/provenance';
import { useCatalogStore } from '@state/catalogStore';
import { useLibraryStore } from '@state/libraryStore';

/**
 * Puts the credit fields a rollback to 2.5.1 stripped back on downloaded maps
 * (`@core/catalog/provenance`), each time the catalog loads an index or a
 * shard, and once the Library is read. A map whose item is not loaded yet is
 * patched when it is (browsing its area, a search). Returns the unsubscribe.
 */
export function installCatalogProvenanceBackfill(): () => void {
  const run = () => {
    const library = useLibraryStore.getState();
    if (!library.hydrated) return;
    const { items, index } = useCatalogStore.getState();
    const patches = provenanceBackfill(library.maps, items, index?.sources ?? []);
    for (const { id, patch } of patches) library.updateMap(id, patch);
  };
  const unsubs = [
    useCatalogStore.subscribe((s, prev) => {
      if (s.items !== prev.items || s.index !== prev.index) run();
    }),
    useLibraryStore.subscribe((s, prev) => {
      if (s.hydrated && !prev.hydrated) run();
    }),
  ];
  run();
  return () => {
    for (const u of unsubs) u();
  };
}
