import type { Folder } from '@core/models';
import { Divider, Menu } from 'react-native-paper';

/**
 * The "Move to folder" block shared by every ⋮ menu. It only appears once a
 * folder exists — a section of nothing but greyed-out placeholders is
 * clutter, not guidance.
 */
export function MoveToFolderItems({
  folders,
  folderId,
  onMove,
}: {
  folders: readonly Folder[];
  /** The item's current folder. */
  folderId: string | undefined;
  /** Move to a folder, or out of every folder (`null`). */
  onMove: (folderId: string | null) => void;
}) {
  if (folders.length === 0) return null;
  return (
    <>
      <Divider />
      <Menu.Item disabled title="Move to folder" />
      {folders.map((f) => (
        <Menu.Item
          key={f.id}
          leadingIcon={folderId === f.id ? 'folder-check' : 'folder-outline'}
          title={f.name}
          // Distinct from the folder section header's text (screen readers
          // and the e2e driver would otherwise hit the header first).
          accessibilityLabel={`Move to ${f.name}`}
          onPress={() => onMove(folderId === f.id ? null : f.id)}
        />
      ))}
      {folderId !== undefined && (
        <Menu.Item
          leadingIcon="folder-off-outline"
          title="Remove from folder"
          onPress={() => onMove(null)}
        />
      )}
    </>
  );
}
