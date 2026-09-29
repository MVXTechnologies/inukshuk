import type { CatalogItem } from '@core/catalog/schema';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import { useCatalogStore } from '@state/catalogStore';
import { useLibraryStore } from '@state/libraryStore';
import { useRouter } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { Portal, Snackbar } from 'react-native-paper';

import { DestinationFolderDialog } from '../DestinationFolderDialog';
import {
  CatalogDownloadCanceled,
  cancelCatalogDownload,
  downloadCatalogItemToLibrary,
} from '../downloadCatalogItem';

/**
 * The store's one download flow, shared by every explorer screen (landing
 * search, filtered list, map, detail): Download asks for a destination folder
 * (user-initiated dialog — the only Portal here), then streams into the
 * Library with progress in `catalogStore.downloads`; Update replaces in place;
 * Open activates the installed map and returns to the Map tab. Outcomes land
 * in a self-timed snackbar (paper's own timer sticks on One UI).
 *
 * The screen renders `overlays` once, at its root.
 */
export interface CatalogDownloadFlow {
  /** Ask for a folder, then download. */
  requestDownload: (item: CatalogItem) => void;
  update: (item: CatalogItem) => void;
  open: (item: CatalogItem) => void;
  cancel: (item: CatalogItem) => void;
  overlays: ReactNode;
}

export function useCatalogDownloadFlow(): CatalogDownloadFlow {
  const router = useRouter();
  const folders = useLibraryStore((s) => s.folders);
  const addFolder = useLibraryStore((s) => s.addFolder);
  const lastFolderId = useCatalogStore((s) => s.lastFolderId);
  const { message, show, dismiss } = useTimedSnackbar(3500);
  const [pending, setPending] = useState<CatalogItem | null>(null);

  const startDownload = useCallback(
    async (item: CatalogItem, folderId: string | null) => {
      try {
        const doc = await downloadCatalogItemToLibrary(item, folderId);
        const folderName =
          folderId === null
            ? null
            : (useLibraryStore.getState().folders.find((f) => f.id === folderId)?.name ?? null);
        show(
          folderName === null
            ? `"${doc.name}" added to Library`
            : `"${doc.name}" added to Library › ${folderName}`,
        );
      } catch (err) {
        if (err instanceof CatalogDownloadCanceled) return;
        show(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [show],
  );

  const update = useCallback(
    (item: CatalogItem) => {
      void (async () => {
        try {
          const doc = await downloadCatalogItemToLibrary(item, null);
          show(`"${doc.name}" updated`);
        } catch (err) {
          if (err instanceof CatalogDownloadCanceled) return;
          show(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    },
    [show],
  );

  const open = useCallback(
    (item: CatalogItem) => {
      const doc = useLibraryStore.getState().maps.find((m) => m.sourceItemId === item.id);
      if (doc === undefined) return;
      useLibraryStore.getState().setActiveMap(doc.id);
      router.navigate('/');
    },
    [router],
  );

  const cancel = useCallback((item: CatalogItem) => cancelCatalogDownload(item.id), []);

  const overlays = (
    <>
      <Portal>
        <DestinationFolderDialog
          key={pending?.id ?? 'closed'}
          visible={pending !== null}
          itemTitle={pending?.title ?? ''}
          {...(pending?.sizeBytes !== undefined ? { sizeBytes: pending.sizeBytes } : {})}
          folders={folders}
          initialFolderId={lastFolderId}
          onCreateFolder={addFolder}
          onDismiss={() => setPending(null)}
          onConfirm={(folderId) => {
            const item = pending;
            setPending(null);
            if (item !== null) void startDownload(item, folderId);
          }}
        />
      </Portal>
      <Snackbar visible={message !== null} onDismiss={dismiss} duration={Infinity}>
        {message ?? ''}
      </Snackbar>
    </>
  );

  return { requestDownload: setPending, update, open, cancel, overlays };
}
