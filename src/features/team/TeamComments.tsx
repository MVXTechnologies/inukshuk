/**
 * Team comments on a shared trail or photo (#589): who, in their team colour
 * and role, when, what — and a box to add one. Used by the team's trail
 * screen and the photo viewer. Comments are signed team ops; the core
 * decides who can see and write them.
 */
import { canCompleteTask, type TeamTask } from '@core/team/tasks';
import type { TeamComment } from '@core/teamui/comments';
import { findMentions } from '@core/teamui/compose';
import { parseTaskCommand, tasksFromSource } from '@core/teamui/tasks';
import type { MemberRow } from '@core/teamui/view';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { IconButton, Text, TextInput } from 'react-native-paper';

import { MemberAvatar, ROLE_LABEL } from './components';
import { TaskChip } from './TaskChip';

/** A comment's text with its `+task @Name` highlighted. */
function CommentText({ text, members }: { text: string; members: readonly MemberRow[] }) {
  const t = useSchemeTokens();
  const cmd = parseTaskCommand(text, members);
  if (cmd === null || !cmd.ok) {
    return (
      <Text variant="bodyLarge" style={{ color: t.ink }} selectable>
        {text}
      </Text>
    );
  }
  const [a, b] = cmd.span;
  return (
    <Text variant="bodyLarge" style={{ color: t.ink }} selectable>
      {text.slice(0, a)}
      <Text style={[styles.command, { color: t.team.taskCommand }]}>{text.slice(a, b)}</Text>
      {text.slice(b)}
    </Text>
  );
}

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
  tasks = [],
  onToggleTask,
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
  /** The team's tasks: those made from a comment show as chips under it. */
  tasks?: readonly TeamTask[];
  onToggleTask?: (task: TeamTask) => void;
}) {
  const t = useSchemeTokens();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(members.map((m) => [m.id, m]));
  const myRole = byId.get(me)?.role;
  const draft = parseTaskCommand(text, members);
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
              <CommentText text={c.text} members={members} />
              {tasksFromSource(tasks, c.author, c.id).map((task) => (
                <TaskChip
                  key={`${task.owner}:${task.id}`}
                  task={task}
                  assigneeName={
                    task.assignee === me ? 'you' : (byId.get(task.assignee)?.name ?? 'a teammate')
                  }
                  canToggle={onToggleTask !== undefined && canCompleteTask(task, me, myRole)}
                  onToggle={() => onToggleTask?.(task)}
                />
              ))}
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
      {draft !== null && draft.ok && error === null && (
        <Text variant="bodySmall" style={{ color: t.inkVariant }} testID="team-task-preview">
          {`Creates a task for ${draft.assignee === me ? 'you' : (byId.get(draft.assignee)?.name ?? 'a teammate')}: ${draft.title}`}
        </Text>
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
  command: { fontWeight: '700' },
});
