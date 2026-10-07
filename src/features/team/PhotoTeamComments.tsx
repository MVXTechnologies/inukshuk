/**
 * The team's comments on a photo, in the photo viewer (#589 + #587): shown
 * when the photo is shared with the open team. Author, team colour, role and
 * time, newest last, and a box to reply.
 */
import { teamService, useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { actionMessage } from './messages';
import { TeamComments } from './TeamComments';

export function PhotoTeamComments({ photoId }: { photoId: string }) {
  const t = useSchemeTokens();
  const view = useTeamStore((s) => s.view);
  const shared = useTeamStore((s) => s.photos.some((p) => p.id === photoId));
  const dataVersion = useTeamStore((s) => s.dataVersion);
  const session = teamService()?.active ?? null;
  const comments = useMemo(
    () => (session ? session.photoComments(photoId) : []),
    // dataVersion: re-read when team data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, photoId, dataVersion],
  );
  if (view === null || session === null || (!shared && comments.length === 0)) return null;
  return (
    <View style={styles.wrap} testID="photo-team-comments">
      <View style={styles.head}>
        <Icon source="account-group-outline" size={16} color={t.inkMuted} />
        <Text variant="labelMedium" style={{ color: t.inkMuted }}>
          {`${view.name.toUpperCase()} · ${comments.length} COMMENT${comments.length === 1 ? '' : 'S'}`}
        </Text>
      </View>
      <TeamComments
        comments={comments.slice(-3)}
        members={view.members}
        me={view.me}
        canWrite={view.active && !view.readOnly}
        placeholder="Reply to the team"
        onSend={(text, mentions) => {
          const err = session.commentOnPhoto(photoId, text, mentions);
          useTeamStore.getState().refresh();
          return err ? actionMessage(err) : null;
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6, marginTop: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
