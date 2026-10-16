import { allCategories } from '@core/library/categories';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Chip, Icon, Surface, Text, useTheme } from '@ui/paper';
import { KeyboardLifted } from '@ui/components/KeyboardLifted';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NewCategoryForm } from './NewCategoryForm';
import { useScaledStyles } from '@ui/displayScale';

interface Props {
  visible: boolean;
  /** Start recording with the chosen activity category id. */
  onStart: (categoryId: string) => void;
  onDismiss: () => void;
}

/**
 * Pre-record activity picker: shown when the user taps "Record track", BEFORE
 * the recording starts. Pick a category (or add a custom one), then Start.
 *
 * Deliberately NOT a paper `<Portal>`/`<Dialog>`: like
 * {@link BackgroundLocationRationale} this sits on the recording path, and
 * paper's Portal animations can leave an invisible touch-swallowing overlay
 * behind on devices with animations disabled (the #108 soft-lock). A
 * conditionally-mounted absolute overlay has no animation to get stuck; theme
 * colors come from paper so it renders correctly in light and dark mode.
 */
export function CategoryStartSheet({ visible, onStart, onDismiss }: Props) {
  // The content component mounts fresh on every open, so its state (selected
  // category defaulting to the last-used one, the add-category form) resets
  // naturally — no state-syncing effect needed.
  if (!visible) return null;
  return <SheetContent onStart={onStart} onDismiss={onDismiss} />;
}

function SheetContent({ onStart, onDismiss }: Omit<Props, 'visible'>) {
  const styles = useScaledStyles(stylesSheet);

  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const customCategories = useLibraryStore((s) => s.customCategories);
  const lastCategory = useSettingsStore((s) => s.lastActivityCategory);
  const setSetting = useSettingsStore((s) => s.set);

  const [selected, setSelected] = useState(lastCategory);
  const [adding, setAdding] = useState(false);

  const categories = allCategories(customCategories);
  // A dangling remembered id (should not happen — customs can't be deleted yet)
  // falls back to the first built-in so Start never records a broken id.
  const selectedId = categories.some((c) => c.id === selected)
    ? selected
    : (categories[0]?.id ?? selected);

  const startWith = (id: string) => {
    setSetting('lastActivityCategory', id);
    onStart(id);
  };

  return (
    <View style={styles.scrim}>
      {/* Tap outside the card to cancel — recording must stay one tap away. */}
      <Pressable
        style={styles.backdrop}
        onPress={onDismiss}
        accessibilityLabel="Cancel recording start"
      />
      <KeyboardLifted>
        <Surface
          style={[
            styles.card,
            { backgroundColor: theme.colors.elevation.level3, paddingBottom: insets.bottom + 16 },
          ]}
        >
          <Text variant="titleMedium" style={styles.title}>
            What are you recording?
          </Text>
          <ScrollView
            style={styles.chipScroll}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.chipWrap}>
              {categories.map((c) => {
                const isSelected = c.id === selectedId;
                return (
                  <Chip
                    key={c.id}
                    mode="outlined"
                    selected={isSelected}
                    showSelectedCheck={false}
                    icon={({ size }) => <Icon source={c.icon} size={size} color={c.color} />}
                    onPress={() => setSelected(c.id)}
                    style={[
                      styles.chip,
                      {
                        borderColor: isSelected ? c.color : theme.colors.outline,
                        borderWidth: isSelected ? 2 : 1,
                        backgroundColor: isSelected ? `${c.color}26` : 'transparent',
                      },
                    ]}
                    accessibilityLabel={`Category ${c.name}${isSelected ? ', selected' : ''}`}
                  >
                    {c.name}
                  </Chip>
                );
              })}
              {!adding && (
                <Chip
                  mode="outlined"
                  icon="plus"
                  onPress={() => setAdding(true)}
                  style={styles.chip}
                  accessibilityLabel="Add category"
                >
                  Add category
                </Chip>
              )}
            </View>
          </ScrollView>

          {adding && (
            <NewCategoryForm
              onAdded={(id) => {
                setSelected(id);
                setAdding(false);
              }}
              onCancel={() => setAdding(false)}
            />
          )}

          <View style={styles.actions}>
            <Button onPress={onDismiss}>Cancel</Button>
            <Button
              mode="contained"
              icon="record-circle"
              onPress={() => startWith(selectedId)}
              accessibilityLabel="Start recording"
            >
              Start
            </Button>
          </View>
        </Surface>
      </KeyboardLifted>
    </View>
  );
}

const stylesSheet = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
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
  },
  title: { marginBottom: 12 },
  chipScroll: { maxHeight: 240 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: 20 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
    marginTop: 16,
  },
});
