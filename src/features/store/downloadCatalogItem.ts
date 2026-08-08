import { findInstalledMap } from '@core/catalog/installStatus';
import type { CatalogItem } from '@core/catalog/schema';
import type { MapDocument } from '@core/models';
import { downloadCatalogPdf, CatalogDownloadCanceled } from '@data/catalogDownload';
import * as storage from '@data/storage';
import { reportError } from '@lib/errorReporting';
import { useCatalogStore } from '@state/catalogStore';
import { useLibraryStore } from '@state/libraryStore';
import { mapDocumentFromStoredPdf } from '../library/importMap';

export { CatalogDownloadCanceled };

/**
 * Download a catalog item and land it in the Library through the standard PDF
 * import path — a store map IS an imported PDF (activate/rename/folders/delete
 * all behave identically); `sourceItemId`/`sourceUpdatedAt` (library schema
 * v5) tie it back to the catalog for dedup and updates.
 *
 * Fresh download: new map id, lands in `folderId`, becomes the active map
 * (via `addMap`, same as any import). Update (the item is already installed):
 * the new file is downloaded and parsed FIRST, under a fresh file id, and only
 * on success replaces the old file — a failed update never costs the user
 * their existing map. Id, name and folder are preserved.
 *
 * Progress lands in `useCatalogStore.downloads` so the bar survives tab
 * switches; {@link cancelCatalogDownload} aborts by item id.
 */

const cancels = new Map<string, () => void>();

/** Cancel an in-flight store download (no-op when none is running). */
export function cancelCatalogDownload(itemId: string): void {
  cancels.get(itemId)?.();
}

export async function downloadCatalogItemToLibrary(
  item: CatalogItem,
  folderId: string | null,
): Promise<MapDocument> {
  const catalog = useCatalogStore.getState();
  if (cancels.has(item.id)) throw new Error('This map is already downloading.');

  const existing = findInstalledMap(useLibraryStore.getState().maps, item.id);
  const fileId = storage.newId();

  catalog.setDownloadProgress(item.id, item.sizeBytes !== undefined ? 0 : null);
  const handle = downloadCatalogPdf(item, fileId, (fraction) =>
    useCatalogStore.getState().setDownloadProgress(item.id, fraction),
  );
  cancels.set(item.id, handle.cancel);

  try {
    const fileUri = await handle.promise;
    let doc: MapDocument;
    try {
      // Parses the stored PDF; on failure it deletes the file so nothing orphans.
      doc = await mapDocumentFromStoredPdf(fileId, fileUri, existing?.name ?? item.title);
    } catch (err) {
      // The generator pre-verifies georeferencing, so a store file that fails
      // to parse is a catalog bug worth a report, not a user error.
      reportError(err, `catalog-download-parse ${item.id}`);
      throw err;
    }
    if (doc.georeferences.length === 0) {
      reportError(
        new Error('catalog map parsed with no georeference'),
        `catalog-georef ${item.id}`,
      );
    }

    const provenance = {
      sourceItemId: item.id,
      ...(item.updatedAt !== undefined ? { sourceUpdatedAt: item.updatedAt } : {}),
    };

    const library = useLibraryStore.getState();
    if (existing !== undefined) {
      // Replace the file under the existing library entry; drop the old bytes.
      storage.deleteFileAt(existing.fileUri);
      library.updateMap(existing.id, {
        fileUri: doc.fileUri,
        importedAt: doc.importedAt,
        pageCount: doc.pageCount,
        georeferences: doc.georeferences,
        activePages: doc.activePages,
        georeferenceWarning: doc.georeferenceWarning,
        ...provenance,
      });
      const updated = useLibraryStore.getState().maps.find((m) => m.id === existing.id);
      return updated ?? { ...existing, ...doc, id: existing.id };
    }

    const stored: MapDocument = {
      ...doc,
      ...provenance,
      ...(folderId !== null ? { folderId } : {}),
    };
    library.addMap(stored);
    useCatalogStore.getState().setLastFolderId(folderId);
    return stored;
  } finally {
    cancels.delete(item.id);
    useCatalogStore.getState().clearDownload(item.id);
  }
}
