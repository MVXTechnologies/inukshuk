import { allCategories, findCategory } from '@core/library/categories';
import { useLibraryStore } from '@state/libraryStore';
import { useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Chip, Icon, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface Props {
  /** Prefilled name (the next "Route N", or the edited route's name). */
  initialName: string;
  /** Preselected activity (the edited route's, or none). */
  initialCategory: string | null;
  /** "6.9 km · ↑ 610 m" — the route being saved, for reassurance. */
  summary: string;
  /** The estimate for a category ("≈ 2 h 40"), recomputed as the chip changes. */
  estimateFor: (categoryId: string | null) => string;
  saving: boolean;
  /** Editing an existing route: the button reads "Save changes". */
  editing: boolean;
  onSave: (name: string, categoryId: string | null) => void;
  onCancel: () => void;
}

/**
 * Name + activity for a drawn route before it goes to the Library (#502).
 * The activity both files the route (its colour and icon in the Library)
 * and picks the pace the estimate uses; none is fine — it is then a
 * Navigation trail estimated at hiking pace.
 *
 * Like the record-start sheet, a conditionally-mounted absolute overlay and
 * never a Portal/Dialog (the #108 invisible-overlay soft-lock).
 */
export function SaveRouteSheet({
  initialName,
  initialCategory,
  summary,
  estimateFor,
  saving,
  editing,
  onSave,
  onCancel,
}: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const customCategories = useLibraryStore((s) => s.customCategories);
  const [name, setName] = useState(initialName);
  const [category, setCategory] = useState<string | null>(
    findCategory(initialCategory, customCategories) ? initialCategory : null,
  );
  // Every activity except "Navigation trail", which is what "none" means here.
  const categories = allCategories(customCategories).filter((c) => c.id !== 'navigation');

  return (
    <View style={styles.scrim}>
      <Pressable style={styles.backdrop} onPress={onCancel} accessibilityLabel="Cancel saving" />
      <Surface
        style={[
          styles.card,
          { backgroundColor: theme.colors.elevation.level3, paddingBottom: insets.bottom + 16 },
        ]}
      >
        <Text variant="titleMedium" style={styles.title}>
          {editing ? 'Save route changes' : 'Save route'}
        </Text>
        <TextInput
          label="Name"
          accessibilityLabel="Route name"
          value={name}
          onChangeText={setName}
          mode="outlined"
          autoCorrect={false}
          returnKeyType="done"
          blurOnSubmit
          onSubmitEditing={() => Keyboard.dismiss()}
        />
        <Text variant="labelLarge" style={styles.section}>
          Activity
        </Text>
        <ScrollView style={styles.chipScroll} keyboardShouldPersistTaps="handled">
          <View style={styles.chipWrap}>
            {categories.map((c) => {
              const on = c.id === category;
              return (
                <Chip
                  key={c.id}
                  mode="outlined"
                  selected={on}
                  showSelectedCheck={false}
                  icon={({ size }) => <Icon source={c.icon} size={size} color={c.color} />}
                  onPress={() => setCategory(on ? null : c.id)}
                  style={[
                    styles.chip,
                    {
                      borderColor: on ? c.color : theme.colors.outline,
                      borderWidth: on ? 2 : 1,
                      backgroundColor: on ? `${c.color}26` : 'transparent',
                    },
                  ]}
                  accessibilityLabel={`Activity ${c.name}${on ? ', selected' : ''}`}
                >
                  {c.name}
                </Chip>
              );
            })}
          </View>
        </ScrollView>
        <Text
          variant="bodyMedium"
          style={[styles.summary, { color: theme.colors.onSurfaceVariant }]}
          testID="save-route-summary"
        >
          {`${summary} · ${estimateFor(category)}`}
        </Text>
        <View style={styles.actions}>
          <Button onPress={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button
            mode="contained"
            icon="content-save-outline"
            loading={saving}
            disabled={saving}
            onPress={() => {
              Keyboard.dismiss();
              onSave(name.trim(), category);
            }}
            accessibilityLabel="Save route to Library"
          >
            {editing ? 'Save changes' : 'Save'}
          </Button>
        </View>
      </Surface>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    zIndex: 20,
    elevation: 20,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  card: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingTop: 20,
    gap: 8,
  },
  title: { marginBottom: 4 },
  section: { marginTop: 6 },
  chipScroll: { maxHeight: 180 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: 20 },
  summary: { marginTop: 4 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
});
