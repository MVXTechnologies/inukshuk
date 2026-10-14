/**
 * A shape's own menu in drawing mode (#683, mockup frame 6): a long-press on
 * one of my shapes (any shape for an admin) shows its time left, a note (40
 * characters, with a counter), Delete and Save. A plain themed View.
 */
import { lifeText, SHAPE_NAMES } from '@core/teamdraw/card';
import { MAX_NOTE_CHARS } from '@core/teamdraw/record';
import type { DrawShape } from '@core/teamdraw/view';
import { teamService, useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Icon, IconButton, Text, TextInput, useTheme } from 'react-native-paper';

import { actionMessage } from '../messages';

const menuClock = () => teamService()?.active?.draw.clock() ?? Date.now();

export function ShapeMenu({
  shape,
  onClose,
  top,
}: {
  shape: DrawShape;
  onClose: () => void;
  top: number;
}) {
  const t = useSchemeTokens();
  const { colors } = useTheme();
  const view = useTeamStore((s) => s.view);
  const [note, setNote] = useState(shape.tx);
  const [now] = useState(menuClock);
  const [error, setError] = useState<string | null>(null);
  const mine = shape.owner === view?.me;
  const author = view?.members.find((m) => m.id === shape.owner)?.name ?? 'A teammate';
  const title = mine ? `Your ${SHAPE_NAMES[shape.sh]}` : `${author}’s ${SHAPE_NAMES[shape.sh]}`;
  const life = lifeText(shape, now, true);
  const done = (err: string | null) => {
    useTeamStore.getState().refresh();
    if (err) setError(actionMessage(err));
    else onClose();
  };
  return (
    <View
      style={[
        styles.pop,
        {
          top,
          backgroundColor: t.surface,
          borderColor: t.outlineVariant,
          shadowColor: palette.shadow,
        },
      ]}
      testID="team-draw-menu"
    >
      <View style={styles.head}>
        <Text variant="titleSmall" style={{ color: t.ink, fontWeight: '800' }} numberOfLines={1}>
          {title}
        </Text>
        <IconButton icon="close" size={20} onPress={onClose} accessibilityLabel="Close" />
      </View>
      <View style={styles.row}>
        <Icon source="timer-sand" size={15} color={t.inkMuted} />
        <Text variant="bodySmall" style={{ color: t.inkMuted }} testID="team-draw-menu-left">
          {life.text}
        </Text>
      </View>
      {mine && (
        <View>
          <TextInput
            mode="outlined"
            label="Note"
            value={note}
            onChangeText={(v) => setNote(v.slice(0, MAX_NOTE_CHARS))}
            maxLength={MAX_NOTE_CHARS}
            returnKeyType="done"
            dense
            testID="team-draw-note"
          />
          <Text
            variant="bodySmall"
            style={[styles.count, { color: t.inkMuted }]}
            testID="team-draw-note-count"
          >
            {`${note.length} / ${MAX_NOTE_CHARS}`}
          </Text>
        </View>
      )}
      {error !== null && (
        <Text variant="bodySmall" style={{ color: colors.error }}>
          {error}
        </Text>
      )}
      <View style={styles.buttons}>
        <Button
          mode="outlined"
          icon="delete-outline"
          textColor={colors.error}
          style={[styles.flex, { borderColor: colors.error }]}
          contentStyle={styles.btn}
          onPress={() => done(teamService()?.active?.draw.remove(shape.owner, shape.id) ?? null)}
          testID="team-draw-menu-delete"
        >
          Delete
        </Button>
        {mine && (
          <Button
            mode="contained"
            style={styles.flex}
            contentStyle={styles.btn}
            onPress={() =>
              note === shape.tx
                ? onClose()
                : done(teamService()?.active?.draw.setNote(shape.id, note.trim()) ?? null)
            }
            testID="team-draw-menu-save"
          >
            Save
          </Button>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pop: {
    position: 'absolute',
    left: 24,
    right: 24,
    maxWidth: 340,
    alignSelf: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 2,
    paddingBottom: 14,
    gap: 8,
    zIndex: 10,
    elevation: 10,
    shadowOpacity: 0.32,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 10 },
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  count: { alignSelf: 'flex-end', marginTop: 2 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 6 },
  btn: { minHeight: 48 },
});
