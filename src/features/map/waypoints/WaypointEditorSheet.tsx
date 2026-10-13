import {
  quickRowIcons,
  withFavoriteToggled,
  withRecentIcon,
} from '@core/library/waypointIconPrefs';
import { waypointIconLabel } from '@core/library/waypointIcons';
import {
  WAYPOINT_COLORS,
  WAYPOINT_PIN_DIAMETER,
  WAYPOINT_RING,
  WAYPOINT_SIZES,
  normalizeWaypointColor,
  waypointInk,
  waypointSize,
  waypointSizeName,
  waypointStyleCaption,
} from '@core/library/waypointStyle';
import type { WaypointIcon, WaypointSize } from '@core/models';
import * as storage from '@data/storage';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useSettingsStore } from '@state/settingsStore';
import { EndCaretTextInput } from '@ui/components/EndCaretTextInput';
import { KeyboardDismissArea } from '@ui/components/KeyboardDismissArea';
import { KEYBOARD_DONE_BAR_ID, KeyboardDoneBar } from '@ui/components/KeyboardDoneBar';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Image,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Button, Text, TextInput, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useIosKeyboardHeight } from '../../common/useIosKeyboardHeight';
import { Segmented } from '../components/mapSheet';
import { IconTile } from './IconTile';
import { WaypointIconPickerPage } from './WaypointIconPickerPage';
import { WaypointPinView } from './WaypointPinView';

/**
 * The minimal waypoint shape the editor needs — satisfied by both a live
 * recording waypoint (`PendingWaypoint`) and a saved standalone `Waypoint`.
 */
export interface EditableWaypoint {
  label: string;
  photoUri?: string;
  /** Chosen pin icon (#350); standalone waypoints only — see `onSetIcon`. */
  icon?: WaypointIcon;
  /** Pin colour and size (#675); standalone waypoints only — see `onSetStyle`. */
  color?: string;
  size?: WaypointSize;
}

/** A colour or size change; `null` puts that field back to its default. */
export interface WaypointStylePatch {
  color?: string | null;
  size?: WaypointSize | null;
}

export interface WaypointEditorProps {
  /** The waypoint being edited; the sheet is up while this is non-null. */
  waypoint: EditableWaypoint | null;
  /**
   * Current NAME draft (#232), owned by the caller like the note draft.
   * Pre-filled with the waypoint's label — for a not-yet-created one that is
   * the next auto number, so a name left untouched numbers exactly as before.
   */
  name: string;
  onChangeName: (text: string) => void;
  /** Current note draft (owned by the caller so it survives photo updates). */
  draft: string;
  onChangeDraft: (text: string) => void;
  /** Save the drafts and close (also the scrim tap and Android Back). */
  onSave: () => void;
  /** Delete the waypoint and close. */
  onDelete: () => void;
  /** Attach a stored photo uri to the waypoint ('' removes the photo). */
  onSetPhoto: (uri: string) => void;
  /**
   * Choose the pin icon (`undefined` = the default pin). **Omitted where the
   * icon cannot be stored** — a live recording waypoint is materialized as a
   * distance-anchored trail note when the recording stops, and a note has no
   * icon, so the picker is not offered rather than silently discarded.
   */
  onSetIcon?: (icon: WaypointIcon | undefined) => void;
  /** Change colour or size (#675). Omitted, like `onSetIcon`, for live pins. */
  onSetStyle?: (patch: WaypointStylePatch) => void;
}

/**
 * The waypoint editor (#675): a tall bottom sheet over a scrim — a plain
 * themed View, never a Paper Dialog/Portal (the invisible-overlay soft-lock)
 * nor a Paper Surface (the iOS flex collapse). It opens on a live preview of
 * the pin, then Name and Note, the icon row (favourites, then recents, then
 * "All icons ›" to the full picker page), 18 colours, the size, the photo,
 * and Delete / Done. Android Back returns from the picker page, else closes
 * (saving), as does a tap on the scrim.
 *
 * Shared by the map (pins, "Add waypoint here", the snackbar's EDIT) and the
 * Library's waypoint rows.
 */
export function WaypointEditorSheet(props: WaypointEditorProps) {
  // Unmount closed editors so failure/retry state belongs to one editing session.
  return props.waypoint ? <EditorContent {...props} /> : null;
}

function EditorContent({
  waypoint,
  name,
  onChangeName,
  draft,
  onChangeDraft,
  onSave,
  onDelete,
  onSetPhoto,
  onSetIcon,
  onSetStyle,
}: WaypointEditorProps) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const keyboardHeight = useIosKeyboardHeight();
  const [error, setError] = useState<string | null>(null);
  const [pendingPhoto, setPendingPhoto] = useState<string | null>(null);
  const [page, setPage] = useState<'main' | 'icons'>('main');
  const iconPrefs = useSettingsStore((s) => s.waypointIcons);
  const setSetting = useSettingsStore((s) => s.set);

  const showError = (err: unknown) =>
    setError(err instanceof Error ? err.message : 'Could not save the waypoint. Please try again.');

  const perform = (action: () => void) => {
    try {
      action();
      setError(null);
    } catch (err) {
      // The caller closes only after its store commit succeeds. Keep its
      // controlled name/note drafts and the sheet available for another try.
      showError(err);
    }
  };

  const retryPhoto = () => {
    if (!pendingPhoto) return;
    onSetPhoto(pendingPhoto);
    setPendingPhoto(null);
  };

  const save = () => {
    retryPhoto();
    onSave();
  };

  /**
   * #235 — put the keyboard away BEFORE the sheet unmounts: closing on top of
   * a live keyboard tears the input accessory view down while iOS still holds
   * it, which XCUITest reproducibly died on.
   */
  const close = (then: () => void) => () => {
    Keyboard.dismiss();
    perform(then);
  };

  // Android Back: out of the picker page first, then close (saving).
  const backRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    backRef.current = () => {
      if (page === 'icons') setPage('main');
      else close(save)();
    };
  });
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      backRef.current();
      return true;
    });
    return () => sub.remove();
  }, []);

  const pickIcon = useCallback(
    (icon: WaypointIcon | undefined) => {
      if (!onSetIcon) return;
      onSetIcon(icon);
      if (icon !== undefined) {
        const prefs = useSettingsStore.getState().waypointIcons;
        const next = withRecentIcon(prefs, icon);
        if (next !== prefs) {
          try {
            setSetting('waypointIcons', next);
          } catch {
            // A recents write is a convenience; the icon itself is saved.
          }
        }
      }
      setPage('main');
    },
    [onSetIcon, setSetting],
  );

  const toggleFavorite = useCallback(
    (icon: WaypointIcon) => {
      try {
        setSetting(
          'waypointIcons',
          withFavoriteToggled(useSettingsStore.getState().waypointIcons, icon),
        );
      } catch {
        // Settings write failed: the star simply does not stick.
      }
    },
    [setSetting],
  );

  const pickPhoto = async (fromCamera: boolean) => {
    if (!waypoint) return;
    let uncommittedPhoto: string | null = null;
    try {
      if (fromCamera) {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) return;
      }
      const res = fromCamera
        ? await ImagePicker.launchCameraAsync({ quality: 0.6 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6 });
      const picked = res.canceled ? null : res.assets[0]?.uri;
      if (!picked) return;
      uncommittedPhoto = await storage.importPhoto(picked, storage.newId());
      onSetPhoto(uncommittedPhoto);
      uncommittedPhoto = null;
      setPendingPhoto(null);
      setError(null);
    } catch (err) {
      // A thrown commit can still leave the new photo referenced by recoverable
      // staged metadata. Retain both assets and retry this same imported copy.
      if (uncommittedPhoto) setPendingPhoto(uncommittedPhoto);
      showError(err);
    }
  };

  if (!waypoint) return null;
  const sheetWidth = Math.min(width, 560);
  const styled = onSetIcon !== undefined || onSetStyle !== undefined;
  const quick = quickRowIcons(waypoint.icon, iconPrefs, 9);
  const favSet = new Set(iconPrefs.favorites);
  const tileW = 64;
  // Nine swatches a row (two rows of nine), sized to the sheet: 28 dp at 360.
  const swatch = Math.min(34, Math.floor((sheetWidth - 40 - 8 * 8) / 9));
  const color = normalizeWaypointColor(waypoint.color);
  const size = waypointSize(waypoint.size);

  return (
    <View style={styles.root} testID="waypoint-editor">
      <Pressable
        style={styles.scrim}
        onPress={close(save)}
        accessibilityRole="button"
        accessibilityLabel="Close waypoint editor"
      />
      <View
        testID="waypoint-editor-sheet"
        style={[
          styles.sheet,
          {
            top: insets.top + 40,
            width: sheetWidth,
            backgroundColor: tokens.surface,
            paddingBottom: keyboardHeight > 0 ? keyboardHeight : insets.bottom,
          },
        ]}
      >
        <View style={[styles.grab, { backgroundColor: tokens.outlineVariant }]} />
        {page === 'icons' ? (
          <WaypointIconPickerPage
            value={waypoint.icon}
            favorites={iconPrefs.favorites}
            recents={iconPrefs.recents}
            onPick={pickIcon}
            onToggleFavorite={toggleFavorite}
            onBack={() => setPage('main')}
            width={sheetWidth}
          />
        ) : (
          <>
            <View style={styles.head}>
              {/* Static title since #232: the name is an editable field below, and a
                  title echoing it would be a second element reading "Waypoint N" —
                  ambiguous for screen readers and for Maestro. */}
              <Text style={[styles.title, { color: tokens.ink }]} accessibilityRole="header">
                Waypoint
              </Text>
              <Button onPress={close(save)} accessibilityLabel="Done">
                Done
              </Button>
            </View>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.body}
              testID="waypoint-editor-scroll"
            >
              <KeyboardDismissArea>
                {styled && (
                  <View
                    style={[
                      styles.preview,
                      {
                        // A patch of 'map' behind the pin, as on the basemap.
                        backgroundColor: theme.dark ? tokens.team.mapHalo : palette.paper,
                        borderColor: tokens.outlineVariant,
                      },
                    ]}
                    accessible
                    accessibilityLabel={`Preview: ${waypointStyleCaption(waypoint)}`}
                    testID="waypoint-preview"
                  >
                    <View style={styles.previewPin}>
                      <WaypointPinView icon={waypoint.icon} color={color} size={size} />
                    </View>
                    <Text style={[styles.caption, { color: tokens.ink }]} numberOfLines={2}>
                      {waypointStyleCaption(waypoint)}
                    </Text>
                  </View>
                )}

                {/* #232 — the name first: naming the place is the point of saving it.
                    Blank falls back to the auto label at the call site. */}
                <TextInput
                  label="Name"
                  // Paper's floating `label` is a sibling Text, not the input's
                  // accessible name — screen readers need it spelled out.
                  accessibilityLabel="Waypoint name"
                  value={name}
                  onChangeText={onChangeName}
                  mode="outlined"
                  autoCorrect={false}
                  style={styles.field}
                  // #235/#240 — single line: Return just puts the keyboard away.
                  returnKeyType="done"
                  blurOnSubmit
                  onSubmitEditing={() => Keyboard.dismiss()}
                />
                <EndCaretTextInput
                  label="Note"
                  value={draft}
                  onChangeText={onChangeDraft}
                  multiline
                  mode="outlined"
                  placeholder="What's here?"
                  // #235 — multiline: Return types a newline, so Done is the only exit.
                  inputAccessoryViewID={KEYBOARD_DONE_BAR_ID}
                />

                {onSetIcon && (
                  <>
                    <Section title="Icon" />
                    <View style={styles.iconRow}>
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        keyboardShouldPersistTaps="handled"
                        style={styles.iconScroll}
                        contentContainerStyle={styles.iconScrollContent}
                      >
                        <View
                          style={styles.iconTiles}
                          accessibilityRole="radiogroup"
                          accessibilityLabel="Pin icon"
                        >
                          {quick.map((icon) => (
                            <IconTile
                              key={icon}
                              icon={icon}
                              label={waypointIconLabel(icon)}
                              selected={icon === waypoint.icon}
                              width={tileW}
                              onPress={pickIcon}
                              favorite={favSet.has(icon)}
                              onToggleFavorite={toggleFavorite}
                            />
                          ))}
                        </View>
                      </ScrollView>
                      <Pressable
                        onPress={() => {
                          Keyboard.dismiss();
                          setPage('icons');
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="All icons"
                        style={({ pressed }) => [
                          styles.allIcons,
                          { borderColor: tokens.outlineVariant },
                          pressed && { backgroundColor: tokens.surfaceVariant },
                        ]}
                      >
                        <MaterialCommunityIcons name="apps" size={24} color={tokens.ink} />
                        <Text style={[styles.allIconsLabel, { color: tokens.inkVariant }]}>
                          All icons ›
                        </Text>
                      </Pressable>
                    </View>
                  </>
                )}

                {onSetStyle && (
                  <>
                    <Section title="Colour" />
                    <View
                      style={styles.swatches}
                      accessibilityRole="radiogroup"
                      accessibilityLabel="Pin colour"
                    >
                      {WAYPOINT_COLORS.map((c) => {
                        const on = c.hex === color;
                        return (
                          <Pressable
                            key={c.hex}
                            onPress={() => perform(() => onSetStyle({ color: on ? null : c.hex }))}
                            accessibilityRole="radio"
                            accessibilityLabel={c.name}
                            accessibilityHint={on ? 'Tap again for the default colour' : undefined}
                            accessibilityState={{ checked: on, selected: on }}
                            hitSlop={3}
                            style={[
                              styles.swatch,
                              {
                                width: swatch,
                                height: swatch,
                                borderRadius: swatch / 2,
                                backgroundColor: c.hex,
                              },
                              c.hex === WAYPOINT_RING && {
                                borderWidth: 1,
                                borderColor: palette.granite,
                              },
                              on && { borderWidth: 2.5, borderColor: tokens.ink },
                            ]}
                          >
                            {on && (
                              <MaterialCommunityIcons
                                name="check"
                                size={18}
                                color={waypointInk(c.hex)}
                              />
                            )}
                          </Pressable>
                        );
                      })}
                    </View>

                    <Section title="Size" />
                    <View style={styles.segment}>
                      <Segmented
                        levels={WAYPOINT_SIZES.map((s) => ({ value: s, label: s }))}
                        selected={size}
                        onSelect={(s) => perform(() => onSetStyle({ size: s === 'M' ? null : s }))}
                      />
                    </View>
                    <View style={styles.sizes}>
                      {WAYPOINT_SIZES.map((s) => (
                        <Pressable
                          key={s}
                          onPress={() => perform(() => onSetStyle({ size: s === 'M' ? null : s }))}
                          accessibilityRole="button"
                          accessibilityLabel={`${waypointSizeName(s)} pin`}
                          accessibilityState={{ selected: s === size }}
                          style={styles.sizeCell}
                        >
                          <WaypointPinView icon={waypoint.icon} color={color} size={s} />
                        </Pressable>
                      ))}
                    </View>
                  </>
                )}

                <Section title="Photo" />
                {waypoint.photoUri ? (
                  <View style={styles.photoWrap}>
                    <Image source={{ uri: waypoint.photoUri }} style={styles.photo} />
                    <Button
                      compact
                      icon="image-remove"
                      onPress={() =>
                        perform(() => {
                          onSetPhoto('');
                          setPendingPhoto(null);
                        })
                      }
                    >
                      Remove photo
                    </Button>
                  </View>
                ) : (
                  <View style={styles.photoButtons}>
                    <Button mode="outlined" icon="image-outline" onPress={() => pickPhoto(false)}>
                      Gallery
                    </Button>
                    <Button mode="outlined" icon="camera-outline" onPress={() => pickPhoto(true)}>
                      Camera
                    </Button>
                  </View>
                )}
                {error ? (
                  <Text
                    accessibilityRole="alert"
                    style={[styles.error, { color: theme.colors.error }]}
                  >
                    {error}
                  </Text>
                ) : null}
                {pendingPhoto ? (
                  <Button icon="reload" onPress={() => perform(retryPhoto)}>
                    Retry photo
                  </Button>
                ) : null}
              </KeyboardDismissArea>
              <View style={styles.footer}>
                <Button textColor={theme.colors.error} onPress={close(onDelete)}>
                  Delete
                </Button>
                <Button onPress={close(save)}>Done</Button>
              </View>
              {/* Mounted HERE, with the field: RCTInputAccessoryComponentView binds
                  to its text input once, when it enters the window (#235). */}
              <KeyboardDoneBar />
            </ScrollView>
          </>
        )}
      </View>
    </View>
  );
}

function Section({ title }: { title: string }) {
  const tokens = useSchemeTokens();
  return (
    <Text style={[styles.section, { color: tokens.inkMuted }]} accessibilityRole="header">
      {title.toUpperCase()}
    </Text>
  );
}

const MAX_PIN = WAYPOINT_PIN_DIAMETER.XL;

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 30 },
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(20,24,28,0.45)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    alignSelf: 'center',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: 'hidden',
  },
  grab: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 10, opacity: 0.8 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 20,
    paddingRight: 8,
    paddingTop: 4,
  },
  title: { fontSize: 20, fontWeight: '800' },
  body: { paddingHorizontal: 20, paddingBottom: 12 },
  preview: {
    height: 96,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 24,
    paddingBottom: 14,
    gap: 16,
    overflow: 'hidden',
  },
  previewPin: { width: MAX_PIN, alignItems: 'center' },
  caption: { flex: 1, fontSize: 13, fontWeight: '700', alignSelf: 'center' },
  field: { marginBottom: 10 },
  section: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, marginTop: 18, marginBottom: 6 },
  iconRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  iconScroll: { flex: 1 },
  iconScrollContent: { paddingRight: 4 },
  iconTiles: { flexDirection: 'row', gap: 4 },
  allIcons: {
    width: 64,
    height: 70,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  allIconsLabel: { fontSize: 10.5, textAlign: 'center' },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  swatch: { alignItems: 'center', justifyContent: 'center' },
  segment: { marginBottom: 6 },
  sizes: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'flex-end',
    height: 70,
  },
  sizeCell: { alignItems: 'center', justifyContent: 'flex-end', minWidth: 56, height: 70 },
  photoWrap: { alignItems: 'flex-start', gap: 6 },
  photo: { width: '100%', height: 180, borderRadius: 10 },
  photoButtons: { flexDirection: 'row', gap: 8 },
  error: { marginTop: 8 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
    paddingHorizontal: 8,
  },
});
