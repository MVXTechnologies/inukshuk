/**
 * The note composer (#706, mockup "Composing"; was the pin composer of #589:
 * owner Q1, a note IS a pin that shows its text). A short sheet over the map:
 * the text with its counter, the colour (my member colour first), "Fades
 * after" (1 h, 4 h, 1 day, trip end) and "Alert team" (off by default, Q3).
 * The note's preview sits dashed on the map where it lands (`NoteCallouts`).
 * Guests post notes too (their pins always could). A plain themed View
 * (paper-surface-ios-flex-collapse).
 */
import {
  DEFAULT_NOTE_FADE,
  MAX_NOTE_CHARS,
  noteLength,
  prepareNoteText,
  type NoteFade,
} from '@core/domains/team/notes';
import { rangeAndBearing } from '@core/teamui/positions';
import { distanceText } from '@core/teamui/teamBar';
import { useSettingsStore } from '@state/settingsStore';
import { teamService, useTeamStore } from '@state/teamStore';
import { KEYBOARD_DONE_BAR_ID, KeyboardDoneBar } from '@ui/components/KeyboardDoneBar';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { Keyboard, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Icon, IconButton, Switch, Text } from '@ui/paper';
import { create } from 'zustand';

import { useOwnColour } from '../draw/drawShared';
import { actionMessage } from '../messages';
import { FadeChoice, noteStylesSheet, noteSwatches, Swatches } from '../notes/noteParts';
import { useScaledStyles } from '@ui/displayScale';

interface PinDraft {
  /** Where the note goes, `[lng, lat]`; null while no composer is open. */
  at: [number, number] | null;
  text: string;
  /** Palette index; null = my member colour. */
  col: number | null;
  fade: NoteFade;
  alert: boolean;
  /** Open the composer at a place; the Draw bar's Text tool passes its style. */
  open: (lng: number, lat: number, style?: { col?: number; fade?: NoteFade }) => void;
  set: (patch: Partial<Pick<PinDraft, 'text' | 'col' | 'fade' | 'alert'>>) => void;
  close: () => void;
}

export const usePinDraft = create<PinDraft>((set) => ({
  at: null,
  text: '',
  col: null,
  fade: DEFAULT_NOTE_FADE,
  alert: false,
  open: (lng, lat, style) =>
    set({
      at: [lng, lat],
      text: '',
      col: style?.col ?? null,
      fade: style?.fade ?? DEFAULT_NOTE_FADE,
      alert: false,
    }),
  set: (patch) => set(patch),
  close: () => set({ at: null, text: '' }),
}));

export function TeamPinComposer({
  onPinned,
  here = null,
}: {
  onPinned: (owner: string, id: string) => void;
  here?: { latitude: number; longitude: number } | null;
}) {
  const noteStyles = useScaledStyles(noteStylesSheet);

  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const units = useSettingsStore((s) => s.units);
  const draft = usePinDraft();
  const view = useTeamStore((s) => s.view);
  const own = useOwnColour();
  const [error, setError] = useState<string | null>(null);
  const at = draft.at;
  if (at === null || view === null) return null;
  const col = draft.col ?? own;
  const count = noteLength(prepareNoteText(draft.text));
  const rb = here ? rangeAndBearing(here, { lat: at[1], lon: at[0] }) : null;
  const sub = rb
    ? `Pinned where you tapped · ${distanceText(rb.meters, units)} ${rb.compass} of you`
    : 'Pinned where you tapped';

  const close = () => {
    Keyboard.dismiss();
    setError(null);
    draft.close();
  };
  const send = () => {
    const session = teamService()?.active;
    if (!session) return;
    const id = session.newId();
    const err = session.postNote(
      at[0],
      at[1],
      draft.text,
      { col, fade: draft.fade, alert: draft.alert },
      id,
    );
    useTeamStore.getState().refresh();
    if (err) {
      setError(actionMessage(err));
      return;
    }
    // The composer (and its focused input) goes away: put the keyboard away
    // with it. Android leaves the IME up when a focused input unmounts, over
    // the new note's card (CI 2026-10-08, run 37820770937).
    close();
    onPinned(session.me, id);
  };

  return (
    <View
      style={[noteStyles.sheet, { backgroundColor: t.surface, shadowColor: palette.shadow }]}
      testID="team-pin-composer"
    >
      <View style={noteStyles.head}>
        <View style={noteStyles.flex}>
          <Text style={[noteStyles.t1, { color: t.ink }]}>New note</Text>
          <Text style={[noteStyles.t2, { color: t.inkMuted }]} numberOfLines={1}>
            {sub}
          </Text>
        </View>
        <IconButton
          icon="close"
          size={22}
          onPress={close}
          accessibilityLabel="Close"
          testID="team-pin-cancel"
        />
      </View>
      <View style={[styles.area, { borderColor: t.support.accent }]}>
        <TextInput
          value={draft.text}
          onChangeText={(text) => draft.set({ text })}
          multiline
          autoFocus
          maxLength={MAX_NOTE_CHARS * 2}
          style={[styles.input, { color: t.ink }]}
          placeholder="What should they know here?"
          placeholderTextColor={t.inkMuted}
          accessibilityLabel="Note text"
          testID="team-pin-input"
          inputAccessoryViewID={KEYBOARD_DONE_BAR_ID}
        />
        <Text
          style={[
            styles.count,
            { color: count > MAX_NOTE_CHARS ? t.status.gpsLostInk : t.inkMuted },
          ]}
          testID="note-count"
        >
          {`${count} / ${MAX_NOTE_CHARS}`}
        </Text>
      </View>
      <KeyboardDoneBar />
      <View style={styles.row}>
        <Text style={[styles.label, { color: t.inkVariant }]}>Colour</Text>
        <Swatches options={noteSwatches(own)} value={col} onChange={(c) => draft.set({ col: c })} />
      </View>
      <View style={styles.row}>
        <Text style={[styles.label, { color: t.inkVariant }]}>Fades after</Text>
        <FadeChoice value={draft.fade} onChange={(fade) => draft.set({ fade })} />
      </View>
      <View style={styles.row}>
        <Text style={[styles.label, { color: t.inkVariant }]}>Alert team</Text>
        <Text style={[styles.hint, { color: t.inkMuted }]}>Buzz everyone’s phone</Text>
        <Switch
          value={draft.alert}
          onValueChange={(alert) => draft.set({ alert })}
          color={t.support.accent}
          accessibilityLabel="Alert team"
          testID="note-alert"
        />
      </View>
      {error !== null && (
        <Text variant="bodySmall" style={[styles.error, { color: t.status.gpsLostInk }]}>
          {error}
        </Text>
      )}
      <Pressable
        onPress={send}
        disabled={count === 0 || count > MAX_NOTE_CHARS}
        accessibilityRole="button"
        accessibilityState={{ disabled: count === 0 || count > MAX_NOTE_CHARS }}
        style={[
          styles.post,
          { backgroundColor: t.support.accent },
          (count === 0 || count > MAX_NOTE_CHARS) && styles.dim,
        ]}
        testID="team-pin-send"
      >
        <Icon source="send" size={20} color={t.support.onAccent} />
        <Text style={[styles.postText, { color: t.support.onAccent }]} numberOfLines={1}>
          {`Post to ${view.name}`}
        </Text>
      </Pressable>
    </View>
  );
}

const stylesSheet = StyleSheet.create({
  area: {
    borderWidth: 2,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 22,
    marginTop: 4,
    marginBottom: 12,
    minHeight: 86,
  },
  input: { fontSize: 16, lineHeight: 22, fontWeight: '600', padding: 0, textAlignVertical: 'top' },
  count: { position: 'absolute', right: 10, bottom: 6, fontSize: 11.5, fontWeight: '800' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  label: { width: 86, fontSize: 13, fontWeight: '800' },
  hint: { flex: 1, fontSize: 13, fontWeight: '600' },
  error: { marginBottom: 8 },
  post: {
    height: 48,
    borderRadius: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  postText: { fontSize: 15.5, fontWeight: '800', flexShrink: 1 },
  dim: { opacity: 0.5 },
});
