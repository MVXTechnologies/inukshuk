/**
 * "Pin a team message" (#589): a message left at a place on the map for the
 * team — where the map point chip is, else the middle of the map. Guests may
 * pin too. `+task @name …` in it makes a task anchored to the new pin.
 */
import { KEYBOARD_DONE_BAR_ID, KeyboardDoneBar } from '@ui/components/KeyboardDoneBar';
import { findMentions } from '@core/teamui/compose';
import { teamService, useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Text, TextInput } from 'react-native-paper';
import { create } from 'zustand';

import { sendTeamComment } from '../taskSend';

export const usePinDraft = create<{
  at: [number, number] | null;
  open: (lng: number, lat: number) => void;
  close: () => void;
}>((set) => ({
  at: null,
  open: (lng, lat) => set({ at: [lng, lat] }),
  close: () => set({ at: null }),
}));

export function TeamPinComposer({ onPinned }: { onPinned: (owner: string, id: string) => void }) {
  const t = useSchemeTokens();
  const at = usePinDraft((s) => s.at);
  const close = usePinDraft((s) => s.close);
  const view = useTeamStore((s) => s.view);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (at === null || view === null) return null;
  const session = teamService()?.active ?? null;

  const send = () => {
    if (!session) return;
    let pinned: string | null = null;
    const err = sendTeamComment({
      session,
      text,
      members: view.members,
      anchor: (id) => ({ kind: 'pin', owner: session.me, id }),
      write: (id) => {
        const e = session.dropPin(at[0], at[1], text, findMentions(text, view.members), id);
        if (e === null) pinned = id;
        return e;
      },
    });
    if (err) {
      setError(err);
      return;
    }
    setText('');
    setError(null);
    close();
    if (pinned) onPinned(session.me, pinned);
  };

  return (
    <View
      style={[styles.card, { backgroundColor: t.elevation.level2, shadowColor: palette.shadow }]}
      testID="team-pin-composer"
    >
      <Text variant="titleMedium" style={{ color: t.ink }}>
        Message here, for the team
      </Text>
      <TextInput
        mode="outlined"
        dense
        multiline
        value={text}
        onChangeText={setText}
        placeholder="What should they know here? +task @name to assign"
        maxLength={4000}
        returnKeyType="send"
        submitBehavior="blurAndSubmit"
        onSubmitEditing={send}
        testID="team-pin-input"
        inputAccessoryViewID={KEYBOARD_DONE_BAR_ID}
      />
      <KeyboardDoneBar />
      {error !== null && (
        <Text variant="bodySmall" style={{ color: t.status.gpsLostInk }}>
          {error}
        </Text>
      )}
      <View style={styles.actions}>
        <Button mode="text" onPress={close} testID="team-pin-cancel">
          Cancel
        </Button>
        <Button
          mode="contained"
          icon="map-marker-plus"
          onPress={send}
          disabled={text.trim().length === 0}
          testID="team-pin-send"
        >
          Pin it
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    padding: 14,
    gap: 8,
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
