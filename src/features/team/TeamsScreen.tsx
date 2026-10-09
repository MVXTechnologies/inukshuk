/** Your teams (#589): the teams on this phone; one is open (syncing) at a time. */
import { reportError } from '@lib/errorReporting';
import { teamService, useTeamStore } from '@state/teamStore';
import { useRouter } from 'expo-router';
import { List } from 'react-native-paper';

import { Note, TeamScreenFrame } from './components';

export function TeamsScreen() {
  const router = useRouter();
  const teams = useTeamStore((s) => s.teams);
  const activeId = useTeamStore((s) => s.activeId);
  return (
    <TeamScreenFrame title="Your teams" testID="team-teams-screen">
      {[...teams]
        .sort((a, b) => (b.lastOpenedAt ?? b.joinedAt) - (a.lastOpenedAt ?? a.joinedAt))
        .map((r) => (
          <List.Item
            key={r.teamId}
            title={r.name}
            description={
              r.teamId === activeId
                ? 'Open · syncing'
                : `Joined ${new Date(r.joinedAt).toLocaleDateString()}`
            }
            left={(p) => (
              <List.Icon
                {...p}
                icon={r.teamId === activeId ? 'account-group' : 'account-group-outline'}
              />
            )}
            right={(p) => <List.Icon {...p} icon="chevron-right" />}
            onPress={() =>
              void teamService()
                ?.activate(r.teamId)
                .then(() => {
                  useTeamStore.getState().refresh();
                  router.replace('/team');
                })
                .catch((e) => reportError(e, 'team-switch'))
            }
          />
        ))}
      <Note>One team syncs at a time: the one you open.</Note>
    </TeamScreenFrame>
  );
}
