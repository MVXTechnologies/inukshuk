import { AREA_COLORS, MAX_TAGS, normalizeTags, parseTagInput } from '@core/library/areas';
import { useIosKeyboardHeight } from '@features/common/useIosKeyboardHeight';
import { palette } from '@ui/tokens';
import { EndCaretTextInput } from '@ui/components/EndCaretTextInput';
import { KEYBOARD_DONE_BAR_ID, KeyboardDoneBar } from '@ui/components/KeyboardDoneBar';
import { useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Image,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Button, Icon, IconButton, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { discardPhotos, pickAreaPhoto } from './areaPhotos';

/** What the editor hands back on Save. */
export interface AreaDraft {
  name: string;
  note: string;
  color: string;
  photoUris: string[];
  tags: string[];
}

interface Props {
  initial: AreaDraft;
  /** "Area · 0.42 km² · perimeter 2.6 km". */
  summary: string;
  /** A saved area being edited (Save reads "Save changes"; "Edit shape" shows). */
  editing: boolean;
  onSave: (draft: AreaDraft) => void;
  onCancel: () => void;
  /** Reopen the drawing tool on this area's corners (saved areas only). */
  onEditShape?: () => void;
  /** Reports a failed photo copy. */
  onError: (message: string) => void;
}

/**
 * The area card's editor (#503, board `Area.dc.html`): name, a multi-line
 * note, photos (the waypoint picker and storage), a colour from the small
 * palette, and optional free tags — with the drawn size for reference.
 *
 * Photo ownership: a photo picked here is copied into app storage at once
 * (like the waypoint editor), so the sheet owns the copies it made until Save
 * hands them to the library; Cancel — or removing one again — deletes them.
 * Photos the area already had are only dropped by the store, after the Save
 * commits.
 *
 * A conditionally-mounted absolute overlay, never a Portal/Dialog.
 */
export function AreaEditorSheet({
  initial,
  summary,
  editing,
  onSave,
  onCancel,
  onEditShape,
  onError,
}: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useIosKeyboardHeight();
  const [name, setName] = useState(initial.name);
  const [note, setNote] = useState(initial.note);
  const [color, setColor] = useState(initial.color);
  const [photos, setPhotos] = useState<string[]>(initial.photoUris);
  const [tags, setTags] = useState<string[]>(initial.tags);
  const [tagText, setTagText] = useState('');
  // Copies this sheet made, which only it owns until Save.
  const added = useRef(new Set<string>());

  const addPhoto = async (fromCamera: boolean) => {
    try {
      const uri = await pickAreaPhoto(fromCamera);
      if (uri === null) return;
      added.current.add(uri);
      setPhotos((p) => [...p, uri]);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not add the photo');
    }
  };

  const removePhoto = (uri: string) => {
    setPhotos((p) => p.filter((x) => x !== uri));
    if (added.current.has(uri)) {
      added.current.delete(uri);
      discardPhotos([uri]);
    }
  };

  const commitTagText = () => {
    const next = normalizeTags([...tags, ...parseTagInput(tagText)]);
    setTags(next);
    setTagText('');
  };

  const cancel = () => {
    Keyboard.dismiss();
    discardPhotos([...added.current]);
    added.current.clear();
    onCancel();
  };

  // Android Back cancels the sheet (discarding its photo copies).
  const cancelRef = useRef(cancel);
  useEffect(() => {
    cancelRef.current = cancel;
  });
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      cancelRef.current();
      return true;
    });
    return () => sub.remove();
  }, []);

  const save = () => {
    Keyboard.dismiss();
    const pending = parseTagInput(tagText);
    added.current.clear(); // the library owns them now
    onSave({
      name: name.trim(),
      note: note.trim(),
      color,
      photoUris: photos,
      tags: normalizeTags([...tags, ...pending]),
    });
  };

  return (
    <View style={[styles.scrim, keyboardHeight > 0 && { paddingBottom: keyboardHeight }]}>
      <Pressable style={styles.backdrop} onPress={cancel} accessibilityLabel="Cancel area edit" />
      <Surface
        style={[
          styles.card,
          { backgroundColor: theme.colors.elevation.level3, paddingBottom: insets.bottom + 12 },
        ]}
      >
        <View style={styles.header}>
          <View style={[styles.swatchMark, { backgroundColor: color }]} />
          <Text variant="titleMedium" style={styles.headerTitle}>
            {editing ? 'Edit area' : 'New area'}
          </Text>
          {onEditShape && (
            <Button compact icon="vector-polygon" onPress={onEditShape}>
              Edit shape
            </Button>
          )}
        </View>
        <Text
          variant="bodySmall"
          style={{ color: theme.colors.onSurfaceVariant }}
          testID="area-editor-summary"
        >
          {summary}
        </Text>
        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <TextInput
            label="Name"
            accessibilityLabel="Area name"
            value={name}
            onChangeText={setName}
            mode="outlined"
            autoCorrect={false}
            returnKeyType="done"
            blurOnSubmit
            onSubmitEditing={() => Keyboard.dismiss()}
          />
          <EndCaretTextInput
            label="Notes"
            accessibilityLabel="Area notes"
            value={note}
            onChangeText={setNote}
            multiline
            mode="outlined"
            placeholder="What's here? Access, season, hazards…"
            inputAccessoryViewID={KEYBOARD_DONE_BAR_ID}
            style={styles.note}
          />

          <Text variant="labelLarge">Colour</Text>
          <View style={styles.swatches} accessibilityRole="radiogroup">
            {AREA_COLORS.map((c) => {
              const on = c.hex === color;
              return (
                <Pressable
                  key={c.hex}
                  onPress={() => setColor(c.hex)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`Colour ${c.name}`}
                  style={[
                    styles.swatch,
                    { backgroundColor: c.hex },
                    on && { borderWidth: 3, borderColor: theme.colors.onSurface },
                  ]}
                >
                  {on && <Icon source="check" size={18} color={palette.white} />}
                </Pressable>
              );
            })}
          </View>

          <Text variant="labelLarge">Photos</Text>
          <View style={styles.photos}>
            {photos.map((uri) => (
              <View key={uri} style={styles.photoWrap}>
                <Image source={{ uri }} style={styles.photo} />
                <IconButton
                  icon="close"
                  size={14}
                  mode="contained"
                  onPress={() => removePhoto(uri)}
                  accessibilityLabel="Remove photo"
                  style={styles.photoRemove}
                />
              </View>
            ))}
            <Pressable
              onPress={() => void addPhoto(false)}
              accessibilityRole="button"
              accessibilityLabel="Add photo"
              style={[styles.addPhoto, { borderColor: theme.colors.outline }]}
            >
              <Icon source="image-plus" size={22} color={theme.colors.onSurfaceVariant} />
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Photo
              </Text>
            </Pressable>
            <Pressable
              onPress={() => void addPhoto(true)}
              accessibilityRole="button"
              accessibilityLabel="Take photo"
              style={[styles.addPhoto, { borderColor: theme.colors.outline }]}
            >
              <Icon source="camera-outline" size={22} color={theme.colors.onSurfaceVariant} />
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Camera
              </Text>
            </Pressable>
          </View>

          <Text variant="labelLarge">Tags</Text>
          {tags.length > 0 && (
            <View style={styles.tags}>
              {tags.map((tag) => (
                <Pressable
                  key={tag}
                  onPress={() => setTags((t) => t.filter((x) => x !== tag))}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove tag ${tag}`}
                  style={[styles.tag, { backgroundColor: theme.colors.secondaryContainer }]}
                >
                  <Text
                    style={[styles.tagLabel, { color: theme.colors.onSecondaryContainer }]}
                    numberOfLines={1}
                  >
                    {tag}
                  </Text>
                  <Icon source="close" size={14} color={theme.colors.onSecondaryContainer} />
                </Pressable>
              ))}
            </View>
          )}
          {tags.length < MAX_TAGS && (
            <TextInput
              label="Add tags (comma separated)"
              accessibilityLabel="Add tags"
              value={tagText}
              onChangeText={setTagText}
              mode="outlined"
              dense
              returnKeyType="done"
              blurOnSubmit={false}
              onSubmitEditing={commitTagText}
              right={
                tagText.trim() !== '' ? (
                  <TextInput.Icon
                    icon="plus"
                    onPress={commitTagText}
                    accessibilityLabel="Add tag"
                  />
                ) : undefined
              }
            />
          )}
        </ScrollView>
        <KeyboardDoneBar />
        <View style={styles.actions}>
          <Button onPress={cancel}>Cancel</Button>
          <Button
            mode="contained"
            icon="content-save-outline"
            onPress={save}
            accessibilityLabel="Save area"
          >
            {editing ? 'Save changes' : 'Save area'}
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
    paddingTop: 16,
    gap: 6,
    maxHeight: '86%',
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerTitle: { flex: 1 },
  swatchMark: { width: 18, height: 18, borderRadius: 5, opacity: 0.85 },
  body: { flexGrow: 0 },
  bodyContent: { gap: 10, paddingVertical: 6 },
  note: { minHeight: 88 },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  swatch: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  photoWrap: { width: 72, height: 72 },
  photo: { width: 72, height: 72, borderRadius: 12 },
  photoRemove: { position: 'absolute', top: -8, right: -8, margin: 0 },
  addPhoto: {
    width: 72,
    height: 72,
    borderRadius: 12,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    minHeight: 32,
    borderRadius: 14,
  },
  tagLabel: { fontSize: 13, lineHeight: 17, fontWeight: '700', maxWidth: 200 },
  // Wraps (primary button onto its own line) rather than squeezing a label.
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
});
