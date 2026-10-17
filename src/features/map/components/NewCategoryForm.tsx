import {
  CATEGORY_COLOR_PALETTE,
  MAX_CATEGORY_NAME_LENGTH,
  validateCategoryName,
} from '@core/library/categories';
import { useLibraryStore } from '@state/libraryStore';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Button, Text, TextInput, useTheme } from '@ui/paper';
import { useScaledStyles } from '@ui/displayScale';

const NAME_ERROR: Record<'empty' | 'too-long' | 'duplicate', string> = {
  empty: 'Give the category a name',
  'too-long': `Keep it under ${MAX_CATEGORY_NAME_LENGTH} characters`,
  duplicate: 'A category with this name already exists',
};

interface Props {
  /** The new custom category was created; its id. */
  onAdded: (id: string) => void;
  onCancel: () => void;
  /** The name field's label. */
  nameLabel?: string;
}

/**
 * Create a custom activity category: a name and a palette colour. Shared by
 * the record-start sheet and the Save route sheet (#736) — inline, never a
 * Portal/Dialog (both live on the map's overlay paths).
 */
export function NewCategoryForm({ onAdded, onCancel, nameLabel = 'Category name' }: Props) {
  const styles = useScaledStyles(stylesSheet);

  const theme = useTheme();
  const customCategories = useLibraryStore((s) => s.customCategories);
  const addCustomCategory = useLibraryStore((s) => s.addCustomCategory);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(CATEGORY_COLOR_PALETTE[0]!);
  const [nameError, setNameError] = useState<string | null>(null);

  const commit = () => {
    const result = validateCategoryName(newName, customCategories);
    if (!result.ok) {
      setNameError(NAME_ERROR[result.reason]);
      return;
    }
    onAdded(addCustomCategory(result.name, newColor));
  };

  return (
    <View style={styles.addForm}>
      <TextInput
        label={nameLabel}
        accessibilityLabel={nameLabel}
        value={newName}
        onChangeText={(text) => {
          setNewName(text);
          setNameError(null);
        }}
        dense
        autoFocus
        maxLength={MAX_CATEGORY_NAME_LENGTH + 8}
        // #235 — Return dismisses the keyboard and adds the category.
        returnKeyType="done"
        blurOnSubmit
        onSubmitEditing={commit}
        error={nameError !== null}
      />
      {nameError !== null && (
        <Text variant="bodySmall" style={{ color: theme.colors.error }}>
          {nameError}
        </Text>
      )}
      <View style={styles.swatchRow}>
        {CATEGORY_COLOR_PALETTE.map((color) => (
          <Pressable
            key={color}
            onPress={() => setNewColor(color)}
            accessibilityLabel={`Color ${color}`}
            style={[
              styles.swatch,
              { backgroundColor: color },
              color === newColor && {
                borderWidth: 3,
                borderColor: theme.colors.onSurface,
              },
            ]}
          />
        ))}
      </View>
      <View style={styles.addActions}>
        <Button onPress={onCancel}>Cancel</Button>
        <Button mode="contained-tonal" onPress={commit}>
          Add
        </Button>
      </View>
    </View>
  );
}

const stylesSheet = StyleSheet.create({
  addForm: { marginTop: 12, gap: 8 },
  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  swatch: { width: 32, height: 32, borderRadius: 16 },
  addActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
