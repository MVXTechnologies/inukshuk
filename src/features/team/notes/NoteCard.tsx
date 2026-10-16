/**
 * A note's card (#706, mockups "Tap a note" and "Your own note"): the text
 * large with its colour bar; Distance, "Fades in" with a ring, "Seen by";
 * the newest reply; Reply, Navigate (primary) and Centre, the teammate
 * card's three slots. Opening it marks the note read here and sends a "seen"
 * receipt once.
 *
 * Its options live in its own ⋮ menu (sub-menu rule): the author gets Edit
 * text, Fades after › (a sub-panel), Move and Delete note; an admin gets
 * Delete only; anyone else sees no ⋮ at all. A plain themed View
 * (paper-surface-ios-flex-collapse).
 */
import { fadeOf, MAX_NOTE_CHARS, NOTE_FADES, type NoteFade } from '@core/domains/team/notes';
import { lifeLeft, noteSpan, seenLine, type NotePin } from '@core/teamui/notes';
import { rangeAndBearing } from '@core/teamui/positions';
import { distanceText } from '@core/teamui/teamBar';
import type { TeamView } from '@core/teamui/view';
import { useSettingsStore } from '@state/settingsStore';
import { teamService, useTeamStore } from '@state/teamStore';
import { KEYBOARD_DONE_BAR_ID, KeyboardDoneBar } from '@ui/components/KeyboardDoneBar';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useState } from 'react';
import { Alert, Keyboard, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Icon, IconButton, Text } from '@ui/paper';

import { MemberAvatar, useNow } from '../components';
import { useTeamMapFocus } from '../map/teamMapFocus';
import { useTeamPick } from '../map/TeamPick';
import { actionMessage } from '../messages';
import { CardAct, Fact, Facts, LifeRing, noteColor, noteStylesSheet } from './noteParts';
import { useScaledStyles, useDisplayScale } from '@ui/displayScale';

type Menu = null | 'main' | 'fade';

export function NoteCard({
  pin,
  view,
  here,
  onNavigate,
  onClose,
}: {
  pin: NotePin;
  view: TeamView;
  here: { latitude: number; longitude: number } | null;
  onNavigate: (latitude: number, longitude: number) => void;
  onClose: () => void;
}) {
  const { sz } = useDisplayScale();

  const noteStyles = useScaledStyles(noteStylesSheet);

  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const units = useSettingsStore((s) => s.units);
  // Re-render whenever team data changes ("Seen by" as receipts arrive).
  useTeamStore((s) => s.dataVersion);
  const now = useNow(30_000);
  const session = teamService()?.active ?? null;
  const [menu, setMenu] = useState<Menu>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mine = pin.owner === view.me;
  const author = view.members.find((m) => m.id === pin.owner);
  const color = noteColor(pin.note.color);
  const root = pin.messages[0]!;
  const replies = pin.messages.slice(1);
  const latest = replies[replies.length - 1];
  const rb = here ? rangeAndBearing(here, { lat: pin.lat, lon: pin.lng }) : null;
  const where = rb ? `${distanceText(rb.meters, units)} ${rb.compass}` : '—';
  const age = noteSpan(now - root.at);
  const ago = age === 'now' ? 'just now' : `${age} ago`;
  const left = Math.max(0, pin.note.expiresAt - now);
  const seen = session ? seenLine(session.noteSeen(pin.owner, pin.id)) : '—';
  const canWrite = view.active && !view.readOnly;
  const hasMenu = canWrite && (mine || view.isAdmin);
  const lastNews = pin.note.newsAt;

  useEffect(() => {
    session?.markNoteSeen(pin.owner, pin.id);
    useTeamStore.getState().refresh();
  }, [session, pin.owner, pin.id, lastNews]);

  const act = (err: string | null | undefined, after?: () => void) => {
    useTeamStore.getState().refresh();
    if (err) setError(actionMessage(err as never));
    else {
      setError(null);
      after?.();
    }
  };
  const remove = () => {
    setMenu(null);
    Alert.alert('Delete this note?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => act(session?.deleteNote(pin.owner, pin.id), onClose),
      },
    ]);
  };
  const current: NoteFade = fadeOf(pin.note.expiresAt, pin.note.fadeFrom);
  const sendReply = () => {
    if (reply === null || reply.trim().length === 0) return;
    act(session?.replyToPin(pin.owner, pin.id, reply), () => {
      Keyboard.dismiss();
      setReply(null);
    });
  };

  return (
    <View>
      {menu === 'main' && (
        <View
          style={[
            styles.menu,
            {
              backgroundColor: t.surface,
              borderColor: t.outlineVariant,
              shadowColor: palette.shadow,
            },
          ]}
          testID="note-menu"
        >
          {mine && (
            <>
              <MenuItem
                icon="pencil-outline"
                label="Edit text"
                testID="note-menu-edit"
                onPress={() => {
                  setMenu(null);
                  setEditing(pin.note.text);
                }}
              />
              <MenuItem
                icon="timer-outline"
                label="Fades after"
                right={NOTE_FADES.find((f) => f.id === current)?.label}
                chevron
                testID="note-menu-fade"
                onPress={() => setMenu('fade')}
              />
              <MenuItem
                icon="cursor-move"
                label="Move"
                testID="note-menu-move"
                onPress={() => {
                  setMenu(null);
                  onClose();
                  useTeamPick.getState().moveNote(pin.id);
                }}
              />
            </>
          )}
          <MenuItem
            icon="delete-outline"
            label="Delete note"
            danger
            testID="note-menu-delete"
            onPress={remove}
          />
        </View>
      )}
      {menu === 'fade' && (
        <View
          style={[
            styles.menu,
            {
              backgroundColor: t.surface,
              borderColor: t.outlineVariant,
              shadowColor: palette.shadow,
            },
          ]}
          testID="note-fade-menu"
        >
          <MenuItem
            icon="arrow-left"
            label="Fades after"
            bold
            testID="note-fade-back"
            onPress={() => setMenu('main')}
          />
          <View style={[styles.menuDiv, { backgroundColor: t.outlineVariant }]} />
          {NOTE_FADES.map((f) => {
            const on = f.id === current;
            return (
              <MenuItem
                key={f.id}
                icon={on ? 'radiobox-marked' : 'radiobox-blank'}
                iconColor={on ? t.support.accent : t.inkMuted}
                label={f.label}
                right={on ? `${noteSpan(left)} left` : undefined}
                testID={`note-fade-${f.id}`}
                onPress={() =>
                  act(session?.editNote(pin.id, { fade: f.id as NoteFade }), () => setMenu(null))
                }
              />
            );
          })}
        </View>
      )}
      <View
        style={[noteStyles.sheet, { backgroundColor: t.surface, shadowColor: palette.shadow }]}
        testID="team-note-card"
      >
        <View style={noteStyles.head}>
          <MemberAvatar
            initials={author?.initials ?? '?'}
            color={author?.color ?? t.inkMuted}
            size={sz(40)}
          />
          <View style={noteStyles.flex}>
            <Text style={[noteStyles.t1, { color: t.ink }]} numberOfLines={1}>
              {mine ? 'Your note' : (author?.name ?? 'A teammate')}
            </Text>
            <Text style={[noteStyles.t2, { color: t.inkMuted }]} numberOfLines={1}>
              {mine ? `${ago} · ${where}` : `Note · ${ago}`}
            </Text>
          </View>
          {hasMenu && (
            <IconButton
              icon="dots-vertical"
              size={22}
              onPress={() => setMenu((m) => (m === null ? 'main' : null))}
              accessibilityLabel="Note options"
              testID="note-more"
            />
          )}
          <IconButton icon="close" size={22} onPress={onClose} accessibilityLabel="Close" />
        </View>

        {editing === null ? (
          <View style={[styles.textWrap, { borderLeftColor: color }]}>
            <Text style={[styles.text, { color: t.ink }]} testID="note-text">
              {pin.note.text}
            </Text>
          </View>
        ) : (
          <View style={styles.editWrap}>
            <TextInput
              value={editing}
              onChangeText={setEditing}
              multiline
              autoFocus
              maxLength={MAX_NOTE_CHARS * 2}
              style={[styles.edit, { color: t.ink, borderColor: t.support.accent }]}
              accessibilityLabel="Note text"
              testID="note-edit-input"
              inputAccessoryViewID={KEYBOARD_DONE_BAR_ID}
            />
            <KeyboardDoneBar />
            <View style={styles.editActs}>
              <Pressable
                onPress={() => setEditing(null)}
                style={styles.link}
                accessibilityRole="button"
                testID="note-edit-cancel"
              >
                <Text style={[styles.linkText, { color: t.inkVariant }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() =>
                  act(session?.editNote(pin.id, { text: editing }), () => {
                    Keyboard.dismiss();
                    setEditing(null);
                  })
                }
                style={styles.link}
                accessibilityRole="button"
                testID="note-edit-save"
              >
                <Text style={[styles.linkText, { color: t.support.accent }]}>Save</Text>
              </Pressable>
            </View>
          </View>
        )}

        <Facts>
          {!mine && <Fact label="Distance" value={where} />}
          <Fact
            label="Fades in"
            value={left > 0 ? noteSpan(left) : 'Faded'}
            lead={<LifeRing left={lifeLeft(pin.note, now)} color={t.support.accent} />}
            divider={!mine}
            testID="note-fades-in"
          />
          <Fact label="Seen by" value={seen} divider testID="note-seen-by" />
          {mine && <Fact label="Replies" value={String(replies.length)} divider />}
        </Facts>

        {latest !== undefined && reply === null && (
          <View
            style={[styles.reply, { backgroundColor: t.surfaceVariant }]}
            testID="note-latest-reply"
          >
            {(() => {
              const by = view.members.find((m) => m.id === latest.author);
              return (
                <>
                  <MemberAvatar
                    initials={by?.initials ?? '?'}
                    color={by?.color ?? t.inkMuted}
                    size={sz(26)}
                  />
                  <View style={noteStyles.flex}>
                    <Text style={[styles.replyBy, { color: t.inkMuted }]}>
                      {`${by?.isMe ? 'You' : (by?.name.split(' ')[0] ?? 'Teammate')} · ${noteSpan(now - latest.at)}`}
                    </Text>
                    <Text style={[styles.replyText, { color: t.ink }]} numberOfLines={3}>
                      {latest.text}
                    </Text>
                  </View>
                </>
              );
            })()}
          </View>
        )}
        {reply !== null && (
          <View style={styles.replyBox}>
            <TextInput
              value={reply}
              onChangeText={setReply}
              autoFocus
              placeholder="Reply"
              placeholderTextColor={t.inkMuted}
              style={[styles.replyInput, { color: t.ink, borderColor: t.outline }]}
              accessibilityLabel="Reply"
              returnKeyType="send"
              submitBehavior="blurAndSubmit"
              onSubmitEditing={sendReply}
              testID="note-reply-input"
            />
            <IconButton
              icon="send"
              size={22}
              disabled={reply.trim().length === 0}
              onPress={sendReply}
              accessibilityLabel="Send reply"
              testID="note-reply-send"
            />
          </View>
        )}
        {error !== null && (
          <Text variant="bodySmall" style={[styles.error, { color: t.status.gpsLostInk }]}>
            {error}
          </Text>
        )}

        <View style={noteStyles.acts}>
          <CardAct
            icon="reply"
            label="Reply"
            testID="note-reply"
            onPress={() => setReply((r) => (r === null ? '' : null))}
          />
          <CardAct
            icon="navigation-variant"
            label="Navigate"
            primary
            testID="note-navigate"
            onPress={() => {
              onNavigate(pin.lat, pin.lng);
              onClose();
            }}
          />
          <CardAct
            icon="image-filter-center-focus"
            label="Centre"
            testID="note-centre"
            onPress={() => useTeamMapFocus.getState().focus(pin.lng, pin.lat, 16)}
          />
        </View>
      </View>
    </View>
  );
}

function MenuItem({
  icon,
  label,
  onPress,
  testID,
  right,
  chevron,
  danger,
  bold,
  iconColor,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  testID: string;
  right?: string | undefined;
  chevron?: boolean;
  danger?: boolean;
  bold?: boolean;
  iconColor?: string;
}) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const ink = danger ? t.status.gpsLostInk : t.ink;
  return (
    <Pressable
      onPress={onPress}
      style={styles.mi}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
    >
      <Icon source={icon} size={22} color={iconColor ?? ink} />
      <Text style={[styles.miText, { color: ink }, bold && styles.bold]}>{label}</Text>
      {(right !== undefined || chevron) && (
        <View style={styles.miRight}>
          {right !== undefined && (
            <Text style={[styles.miRightText, { color: t.inkMuted }]}>{right}</Text>
          )}
          {chevron && <Icon source="chevron-right" size={18} color={t.inkMuted} />}
        </View>
      )}
    </Pressable>
  );
}

const stylesSheet = StyleSheet.create({
  textWrap: { borderLeftWidth: 4, paddingLeft: 12, marginTop: 12, marginBottom: 2 },
  text: { fontSize: 18, lineHeight: 25, fontWeight: '700' },
  editWrap: { marginTop: 10 },
  edit: {
    borderWidth: 2,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '600',
    minHeight: 64,
    textAlignVertical: 'top',
  },
  editActs: { flexDirection: 'row', justifyContent: 'flex-end', gap: 16, paddingTop: 6 },
  link: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 4 },
  linkText: { fontSize: 15, fontWeight: '800' },
  reply: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 10,
    borderRadius: 14,
    marginBottom: 12,
  },
  replyBy: { fontSize: 11.5, fontWeight: '700' },
  replyText: { fontSize: 13.5, lineHeight: 18, fontWeight: '600' },
  replyBox: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 12 },
  replyInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    height: 44,
    fontSize: 15,
  },
  error: { marginBottom: 8 },
  menu: {
    position: 'absolute',
    right: 16,
    bottom: '100%',
    marginBottom: -56,
    width: 228,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
    zIndex: 10,
    elevation: 12,
    shadowOpacity: 0.32,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 10 },
  },
  menuDiv: { height: 1, marginVertical: 2 },
  mi: { flexDirection: 'row', alignItems: 'center', gap: 12, height: 48, paddingHorizontal: 14 },
  miText: { fontSize: 15, fontWeight: '700', flex: 1 },
  bold: { fontWeight: '800' },
  miRight: { flexDirection: 'row', alignItems: 'center' },
  miRightText: { fontSize: 13, fontWeight: '700' },
});
