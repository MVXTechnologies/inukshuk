import { itemCount, type MoveOption } from '@core/library/selection';
import { tabularNums } from '@ui/fonts';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { StyleSheet, Text as RNText } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { LibrarySheet, SheetDivider, SheetRow, sheetStyles } from './LibrarySheet';

/**
 * "Move 5 items to…" (#711): New folder… first (it names a folder, then the
 * items go in), the folders in their Organize order with their counts, the
 * one every selected item is already in marked "· current" (a no-op), and
 * "Remove from folder" last, only when it applies.
 */
export function MoveToFolderSheet({
  visible,
  focused,
  title,
  subtitle,
  newFolderDetail,
  options,
  canRemove,
  onNewFolder,
  onMove,
  onClose,
}: {
  visible: boolean;
  focused: boolean;
  /** "Move 5 items to…" */
  title: string;
  /** The kind summary. */
  subtitle: string;
  /** "Name it, and the 5 items go in". */
  newFolderDetail: string;
  options: readonly MoveOption[];
  canRemove: boolean;
  onNewFolder: () => void;
  /** A folder id, or null for Remove from folder. */
  onMove: (folderId: string | null) => void;
  onClose: () => void;
}) {
  const t = useSchemeTokens();
  return (
    <LibrarySheet
      visible={visible}
      focused={focused}
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      testID="library-move-sheet"
    >
      <SheetRow
        accent
        icon={<Icon source="folder-plus-outline" size={24} color={t.ink} />}
        label="New folder…"
        detail={<Text style={[sheetStyles.detail, { color: t.inkMuted }]}>{newFolderDetail}</Text>}
        onPress={onNewFolder}
        accessibilityLabel="New folder…"
        testID="library-move-new-folder"
      />
      {options.length > 0 && <SheetDivider />}
      {options.map(({ folder, count, current }) => (
        <SheetRow
          key={folder.id}
          icon={<Icon source="folder-outline" size={24} color={t.ink} />}
          label={folder.name}
          labelSuffix={current ? '· current' : undefined}
          trailing={
            <RNText style={[styles.count, { color: t.inkMuted }]}>{itemCount(count)}</RNText>
          }
          // The folder everything is in already: closing is all it does.
          onPress={() => (current ? onClose() : onMove(folder.id))}
          accessibilityLabel={`${folder.name}, ${itemCount(count)}${current ? ', current folder' : ''}`}
          testID={`library-move-to-${folder.id}`}
        />
      ))}
      {canRemove && (
        <>
          <SheetDivider />
          <SheetRow
            icon={<Icon source="folder-off-outline" size={24} color={t.ink} />}
            label="Remove from folder"
            onPress={() => onMove(null)}
            accessibilityLabel="Remove from folder"
            testID="library-move-remove"
          />
        </>
      )}
    </LibrarySheet>
  );
}

const styles = StyleSheet.create({
  count: { fontSize: 13, lineHeight: 17, fontWeight: '700', ...tabularNums },
});
