/**
 * "Julie left a note · 320 m NE" (#706, mockup "a new one arriving"): one line
 * and the note's text, with VIEW, when a teammate's note I have not opened
 * arrives. Silent (owner Q3): only its author's "Alert team" buzzes, through
 * the notifications. Notes already there when the map opened are not
 * announced; one synced after a time offline is. The timer is `useTimedSnackbar`'s own (never Paper's Snackbar,
 * which sticks on One UI).
 */
import { isNote, newsKey, noteArrival, type NotePin } from '@core/teamui/notes';
import { rangeAndBearing } from '@core/teamui/positions';
import { distanceText } from '@core/teamui/teamBar';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import { useSettingsStore } from '@state/settingsStore';
import { useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { useTeamMapSelection } from '../map/TeamMapOverlay';

export const NOTE_SNACK_MS = 6_000;

export function NoteSnack({
  here,
  style,
}: {
  here: { latitude: number; longitude: number } | null;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useSchemeTokens();
  const units = useSettingsStore((s) => s.units);
  const pins = useTeamStore((s) => s.pins);
  const me = useTeamStore((s) => s.view?.me ?? '');
  const members = useTeamStore((s) => s.view?.members);
  const seen = useTeamStore((s) => s.record?.seen);
  // Notes there when the map opened are not news; each announced one joins them.
  const known = useRef<Set<string> | null>(null);
  const [note, setNote] = useState<NotePin | null>(null);
  const { message, show, dismiss } = useTimedSnackbar(NOTE_SNACK_MS);

  useEffect(() => {
    if (me === '') return;
    if (known.current === null) {
      known.current = new Set(pins.filter(isNote).map(newsKey));
      return;
    }
    const p = noteArrival(pins, me, (th) => seen?.[th] ?? 0, known.current, Date.now());
    if (p === null) return;
    known.current.add(newsKey(p));
    const who = members?.find((m) => m.id === p.owner)?.name.split(' ')[0] ?? 'A teammate';
    const rb = here ? rangeAndBearing(here, { lat: p.lat, lon: p.lng }) : null;
    setNote(p);
    show(
      rb
        ? `${who} left a note · ${distanceText(rb.meters, units)} ${rb.compass}`
        : `${who} left a note`,
    );
    // A new arrival only: not every fix of `here`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, me, seen, members]);

  if (message === null || note === null) return null;
  return (
    <View style={[styles.wrap, style]} pointerEvents="box-none">
      <View
        style={[styles.snack, { backgroundColor: t.team.snack }]}
        accessibilityLiveRegion="polite"
        testID="note-snack"
      >
        <Icon source="note-text" size={22} color={t.team.snackInk} />
        <View style={styles.tx}>
          <Text style={[styles.title, { color: t.team.snackInk }]} numberOfLines={1}>
            {message}
          </Text>
          <Text style={[styles.quote, { color: t.team.snackInk }]} numberOfLines={1}>
            {`“${note.note.text}”`}
          </Text>
        </View>
        <Pressable
          onPress={() => {
            dismiss();
            useTeamMapSelection.getState().select({ kind: 'pin', owner: note.owner, id: note.id });
          }}
          style={styles.action}
          accessibilityRole="button"
          accessibilityLabel="View"
          testID="note-snack-view"
          hitSlop={6}
        >
          <Text style={[styles.actionText, { color: t.team.snackAccent }]}>VIEW</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12 },
  snack: {
    minHeight: 56,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 6,
    elevation: 6,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 6 },
  },
  tx: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, lineHeight: 18, fontWeight: '700' },
  quote: { fontSize: 12.5, fontWeight: '700', opacity: 0.78 },
  action: { height: 44, paddingHorizontal: 12, justifyContent: 'center' },
  actionText: { fontSize: 14.5, fontWeight: '900', letterSpacing: 0.6 },
});
