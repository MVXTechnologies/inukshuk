/**
 * The team's comments on a photo, in the photo viewer (#589 + #587): shown
 * when the photo is shared with the open team. Author, team colour, role and
 * time, newest last, a box to reply, and the tasks made from them with
 * `+task @name …` (anchored to this photo) as chips.
 */
import { teamService, useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { sendTeamComment } from './taskSend';
import { TeamComments } from './TeamComments';
import { useToggleTask } from './useToggleTask';

export function PhotoTeamComments({ photoId }: { photoId: string }) {
  const t = useSchemeTokens();
  const view = useTeamStore((s) => s.view);
  const photo = useTeamStore((s) => s.photos.find((p) => p.id === photoId));
  const tasks = useTeamStore((s) => s.tasks);
  const dataVersion = useTeamStore((s) => s.dataVersion);
  const session = teamService()?.active ?? null;
  const toggle = useToggleTask();
  const comments = useMemo(
    () => (session ? session.photoComments(photoId) : []),
    // dataVersion: re-read when team data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, photoId, dataVersion],
  );
  // Looking at the photo's thread clears its "new" bubble on the map.
  useEffect(() => {
    if (session && comments.length > 0) session.markSeen(`photo:${photoId}`);
  }, [session, photoId, comments.length]);
  if (view === null || session === null || (photo === undefined && comments.length === 0))
    return null;
  const count = comments.length;
  return (
    <View style={styles.wrap} testID="photo-team-comments">
      <View style={styles.head}>
        <Icon source="account-group-outline" size={16} color={t.inkMuted} />
        <Text variant="labelMedium" style={{ color: t.inkMuted }}>
          {`${view.name.toUpperCase()} · ${count} COMMENT${count === 1 ? '' : 'S'}`}
        </Text>
      </View>
      <TeamComments
        comments={comments.slice(-4)}
        members={view.members}
        me={view.me}
        canWrite={view.active && !view.readOnly}
        placeholder="Reply, or +task @name to assign"
        tasks={tasks}
        onToggleTask={toggle}
        onSend={(text, mentions) =>
          sendTeamComment({
            session,
            text,
            members: view.members,
            anchor: photo ? { kind: 'photo', owner: photo.owner, id: photoId } : null,
            write: (id) => session.commentOnPhoto(photoId, text, mentions, id),
          })
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6, marginTop: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
