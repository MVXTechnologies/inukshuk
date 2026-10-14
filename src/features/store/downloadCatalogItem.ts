import { itemCredit } from '@core/catalog/credit';
import { findInstalledMap } from '@core/catalog/installStatus';
import type { CatalogItem, CatalogSource } from '@core/catalog/schema';
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

/**
 * What a downloaded map remembers of its catalog item: the dedup/update keys
 * (`sourceItemId`, `sourceUpdatedAt`, `sourceVersion`) and, for a publisher
 * whose terms require it (#680), the author credit, the "free at" host and the
 * map's page, so the Library row credits the author offline.
 */
export function catalogProvenance(
  item: CatalogItem,
  source: CatalogSource | undefined,
): Pick<
  MapDocument,
  | 'sourceItemId'
  | 'sourceUpdatedAt'
  | 'sourceVersion'
  | 'sourceCredit'
  | 'sourceFreeAt'
  | 'sourcePageUrl'
> {
  const credit = itemCredit(item);
  return {
    sourceItemId: item.id,
    ...(item.updatedAt !== undefined ? { sourceUpdatedAt: item.updatedAt } : {}),
    ...(item.version !== undefined ? { sourceVersion: item.version } : {}),
    ...(credit !== undefined ? { sourceCredit: credit } : {}),
    ...(source?.freeAt !== undefined ? { sourceFreeAt: source.freeAt } : {}),
    ...(item.pageUrl !== undefined ? { sourcePageUrl: item.pageUrl } : {}),
  };
}

/** Cancel an in-flight store download (no-op when none is running). */
export function cancelCatalogDownload(itemId: string): void {
  cancels.get(itemId)?.();
}

function deleteOrphan(uri: string): void {
  try {
    storage.deleteFileAt(uri);
  } catch {
    // Cleanup cannot roll back a committed map or mask the original save error.
  }
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

  let uncommittedFileUri: string | null = null;
  let commitAttempted = false;
  try {
    const fileUri = await handle.promise;
    uncommittedFileUri = fileUri;
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
    // A plain-PDF item (#680) is listed as "not placed yet": no georeference
    // is expected. A GeoPDF without one is a catalog bug.
    if (doc.georeferences.length === 0 && item.format === 'geopdf') {
      reportError(
        new Error('catalog map parsed with no georeference'),
        `catalog-georef ${item.id}`,
      );
    }

    const provenance = catalogProvenance(
      item,
      catalog.index?.sources.find((s) => s.id === item.sourceId),
    );

    const library = useLibraryStore.getState();
    // The store intentionally skips writes before hydration. Do not treat an
    // in-memory-only update as a durable commit and remove the last good file.
    if (!library.hydrated) throw new Error('The library is still loading. Please try again.');
    if (existing !== undefined) {
      const current = library.maps.find((m) => m.id === existing.id);
      // Downloading/parsing yields to deletion and other replacements. Never
      // resurrect an installation or overwrite a newer file when it completes.
      if (!current || current.fileUri !== existing.fileUri || current.sourceItemId !== item.id) {
        throw new CatalogDownloadCanceled();
      }
      const patch = {
        fileUri: doc.fileUri,
        importedAt: doc.importedAt,
        pageCount: doc.pageCount,
        georeferences: doc.georeferences,
        activePages: doc.activePages,
        georeferenceWarning: doc.georeferenceWarning,
        ...provenance,
      };
      commitAttempted = true;
      library.updateMap(existing.id, patch);
      uncommittedFileUri = null;
      deleteOrphan(current.fileUri);
      return { ...current, ...patch };
    }

    const stored: MapDocument = {
      ...doc,
      ...provenance,
      ...(folderId !== null ? { folderId } : {}),
    };
    commitAttempted = true;
    library.addMap(stored);
    uncommittedFileUri = null;
    useCatalogStore.getState().setLastFolderId(folderId);
    return stored;
  } catch (err) {
    // A failed promotion can leave the replacement index readable in .tmp.
    // Keep both files once a commit was attempted: either index may recover.
    if (!commitAttempted && uncommittedFileUri !== null) deleteOrphan(uncommittedFileUri);
    throw err;
  } finally {
    cancels.delete(item.id);
    useCatalogStore.getState().clearDownload(item.id);
  }
}
