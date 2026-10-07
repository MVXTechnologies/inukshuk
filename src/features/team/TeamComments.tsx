/**
 * Team comments on a shared trail or photo (#589): who, in their team colour
 * and role, when, what — and a box to add one. Used by the team's trail
 * screen and the photo viewer. Comments are signed team ops; the core
 * decides who can see and write them.
 */
import type { TeamComment } from '@core/teamui/comments';
import { findMentions } from '@core/teamui/compose';
import type { MemberRow } from '@core/teamui/view';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { IconButton, Text, TextInput } from 'react-native-paper';

import { MemberAvatar, ROLE_LABEL } from './components';

export function commentTime(at: number): string {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${hm}`;
}

export function TeamComments({
  comments,
  members,
  me,
  onSend,
  placeholder,
  photoLabel,
  canWrite,
  testID,
}: {
  comments: readonly TeamComment[];
  members: readonly MemberRow[];
  me: string;
  /** Returns an error message, or null when sent. */
  onSend: ((text: string, mentions: string[]) => string | null) | null;
  placeholder: string;
  /** "Photo 3" for a comment about a photo, shown in a trail-wide list. */
  photoLabel?: (photoId: string) => string | null;
  canWrite: boolean;
  testID?: string;
}) {
  const t = useSchemeTokens();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(members.map((m) => [m.id, m]));
  const send = () => {
    if (!onSend) return;
    const err = onSend(text, findMentions(text, members));
    if (err) setError(err);
    else {
      setText('');
      setError(null);
    }
  };
  return (
    <View style={styles.wrap} testID={testID}>
      {comments.length === 0 && (
        <Text variant="bodyMedium" style={{ color: t.inkVariant }}>
          No comments yet.
        </Text>
      )}
      {comments.map((c) => {
        const m = byId.get(c.author);
        const name = c.author === me ? 'You' : (m?.name ?? 'A teammate');
        const about = c.photoId && photoLabel ? photoLabel(c.photoId) : null;
        return (
          <View key={`${c.author}:${c.id}`} style={styles.row} testID="team-comment">
            <MemberAvatar initials={m?.initials ?? '?'} color={m?.color ?? t.inkMuted} size={30} />
            <View style={styles.flex}>
              <Text variant="labelLarge" style={{ color: t.ink }}>
                {name}
                <Text variant="bodySmall" style={{ color: t.inkMuted }}>
                  {m && c.author !== me ? `  ${ROLE_LABEL[m.role]}` : ''}
                  {`  ${commentTime(c.at)}`}
                  {about ? `  · ${about}` : ''}
                </Text>
              </Text>
              <Text variant="bodyLarge" style={{ color: t.ink }} selectable>
                {c.text}
              </Text>
            </View>
          </View>
        );
      })}
      {canWrite && onSend && (
        <View style={styles.composer}>
          <TextInput
            mode="outlined"
            dense
            style={styles.flex}
            value={text}
            onChangeText={setText}
            placeholder={placeholder}
            returnKeyType="send"
            onSubmitEditing={send}
            submitBehavior="submit"
            maxLength={4000}
            testID="team-comment-input"
          />
          <IconButton
            icon="send"
            mode="contained"
            onPress={send}
            disabled={text.trim().length === 0}
            accessibilityLabel="Send comment"
            testID="team-comment-send"
          />
        </View>
      )}
      {error !== null && (
        <Text variant="bodySmall" style={{ color: t.status.gpsLostInk }}>
          {error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  wrap: { gap: space.sm },
  row: { flexDirection: 'row', gap: space.sm, paddingVertical: 4 },
  composer: { flexDirection: 'row', alignItems: 'center' },
});
