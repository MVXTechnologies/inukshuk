import {
  allCategories,
  type CategoryDefinition,
  findCategory,
  NAVIGATION_CATEGORY_ID,
} from '@core/library/categories';
import { useLibraryStore } from '@state/libraryStore';
import { KeyboardLifted } from '@ui/components/KeyboardLifted';
import { useEffect, useRef, useState } from 'react';
import { BackHandler, Keyboard, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Chip, Icon, Surface, Text, TextInput, TouchableRipple, useTheme } from '@ui/paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NewCategoryForm } from '../components/NewCategoryForm';
import { useScaledStyles } from '@ui/displayScale';

/**
 * The chips always on show, in order: Navigation trail (the default) and the
 * four commonest planned-route activities. Everything else is behind "+".
 */
export const SAVE_ROUTE_COMMON_CATEGORIES: readonly string[] = [
  NAVIGATION_CATEGORY_ID,
  'hike',
  'trail-run',
  'bike',
  'ski',
];

interface Props {
  /** Prefilled name (the next "Route N", or the edited route's name). */
  initialName: string;
  /** Preselected activity (the edited route's); none or unknown → Navigation trail. */
  initialCategory: string | null | undefined;
  /** "6.9 km · ↑ 610 m" — the route being saved, for reassurance. */
  summary: string;
  /** The estimate for a category ("≈ 2 h 40"), recomputed as the chip changes. */
  estimateFor: (categoryId: string) => string;
  saving: boolean;
  /** Editing an existing route: the button reads "Save changes". */
  editing: boolean;
  /** Always a category id; `'navigation'` for a plain Navigation trail. */
  onSave: (name: string, categoryId: string) => void;
  onCancel: () => void;
}

/**
 * Name + activity for a drawn route before it goes to the Library (#502).
 * The activity both files the route (its colour and icon in the Library)
 * and picks the pace the estimate uses. Navigation trail is a chip of its
 * own and the default (#736) — what a route saved with no activity always
 * became — estimated at hiking pace. "+" unfolds every activity, the user's
 * own and "New activity…" in the sheet itself; one picked there that is not
 * on show joins the chips, before "+".
 *
 * Like the record-start sheet, a conditionally-mounted absolute overlay and
 * never a Portal/Dialog/Menu (the #108 invisible-overlay soft-lock).
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
  const styles = useScaledStyles(stylesSheet);

  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const customCategories = useLibraryStore((s) => s.customCategories);
  const [name, setName] = useState(initialName);
  const initial = findCategory(initialCategory, customCategories)?.id ?? NAVIGATION_CATEGORY_ID;
  const [category, setCategory] = useState(initial);
  // An activity picked from "+" (or the edited route's) that has no chip of its own.
  const [pinned, setPinned] = useState<string | null>(
    SAVE_ROUTE_COMMON_CATEGORIES.includes(initial) ? null : initial,
  );
  const [menu, setMenu] = useState<'closed' | 'list' | 'new'>('closed');
  const all = allCategories(customCategories);
  const chips = [...SAVE_ROUTE_COMMON_CATEGORIES, ...(pinned !== null ? [pinned] : [])]
    .map((id) => all.find((c) => c.id === id))
    .filter((c): c is CategoryDefinition => c !== undefined);
  const choose = (id: string) => {
    setCategory(id);
    if (!SAVE_ROUTE_COMMON_CATEGORIES.includes(id)) setPinned(id);
    setMenu('closed');
  };
  // Android Back folds the "+" list first, then cancels the sheet.
  const menuRef = useRef(menu);
  useEffect(() => {
    menuRef.current = menu;
  });
  const cancelRef = useRef(onCancel);
  useEffect(() => {
    cancelRef.current = onCancel;
  });
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (menuRef.current !== 'closed') setMenu('closed');
      else cancelRef.current();
      return true;
    });
    return () => sub.remove();
  }, []);

  return (
    <View style={styles.scrim}>
      <Pressable style={styles.backdrop} onPress={onCancel} accessibilityLabel="Cancel saving" />
      <KeyboardLifted>
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
              {chips.map((c) => {
                const on = c.id === category;
                return (
                  <Chip
                    key={c.id}
                    mode="outlined"
                    selected={on}
                    showSelectedCheck={false}
                    icon={({ size }) => <Icon source={c.icon} size={size} color={c.color} />}
                    // A second tap on the picked activity falls back to the default.
                    onPress={() => setCategory(on ? NAVIGATION_CATEGORY_ID : c.id)}
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
              <TouchableRipple
                borderless
                onPress={() => setMenu(menu === 'closed' ? 'list' : 'closed')}
                style={[
                  styles.plusChip,
                  {
                    borderColor: theme.colors.outline,
                    backgroundColor:
                      menu !== 'closed' ? theme.colors.secondaryContainer : 'transparent',
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel="More activities"
                accessibilityState={{ expanded: menu !== 'closed' }}
              >
                <Icon source="plus" size={18} color={theme.colors.onSurfaceVariant} />
              </TouchableRipple>
            </View>
          </ScrollView>
          {menu === 'list' && (
            <View
              style={[
                styles.menu,
                { backgroundColor: theme.colors.surface, borderColor: theme.colors.outlineVariant },
              ]}
            >
              <ScrollView style={styles.menuScroll} keyboardShouldPersistTaps="handled">
                {all.map((c) => (
                  <MenuRow
                    key={c.id}
                    category={c}
                    selected={c.id === category}
                    onPress={() => choose(c.id)}
                  />
                ))}
                <TouchableRipple
                  onPress={() => setMenu('new')}
                  accessibilityRole="menuitem"
                  accessibilityLabel="New activity"
                >
                  <View style={styles.menuRow}>
                    <Icon source="plus" size={20} color={theme.colors.onSurfaceVariant} />
                    <Text variant="bodyLarge" style={styles.menuLabel}>
                      New activity…
                    </Text>
                  </View>
                </TouchableRipple>
              </ScrollView>
            </View>
          )}
          {menu === 'new' && (
            <NewCategoryForm
              nameLabel="Activity name"
              onAdded={choose}
              onCancel={() => setMenu('list')}
            />
          )}
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
      </KeyboardLifted>
    </View>
  );
}

function MenuRow({
  category: c,
  selected,
  onPress,
}: {
  category: CategoryDefinition;
  selected: boolean;
  onPress: () => void;
}) {
  const styles = useScaledStyles(stylesSheet);

  const theme = useTheme();
  return (
    <TouchableRipple
      onPress={onPress}
      accessibilityRole="menuitem"
      accessibilityLabel={`${c.name}${selected ? ', selected' : ''}`}
      accessibilityState={{ selected }}
    >
      <View style={styles.menuRow}>
        <Icon source={c.icon} size={20} color={c.color} />
        <Text variant="bodyLarge" style={styles.menuLabel} numberOfLines={1}>
          {c.name}
        </Text>
        {selected && <Icon source="check" size={20} color={theme.colors.primary} />}
      </View>
    </TouchableRipple>
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
  // A chip's outline and height, holding only the "+" glyph.
  plusChip: {
    height: 32,
    minWidth: 48,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menu: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  menuScroll: { maxHeight: 240 },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    minHeight: 48,
  },
  menuLabel: { flex: 1 },
  summary: { marginTop: 4 },
  // Wraps (primary button onto its own line) rather than squeezing a label.
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
});
