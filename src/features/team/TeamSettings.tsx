/**
 * Team mode in Settings → Extensions (#589): Get / switch / Remove through
 * the shared frame; once installed, a compact body — the active team (one
 * row into the team screen), Create, Join and the privacy line. Everything
 * heavier (members, invites, chat) lives on its own screens.
 */
import { ExtensionSettingsShell } from '@features/extensions/ExtensionSettingsShell';
import { useExtensionPrefs } from '@features/extensions/prefs';
import { useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { List, Text } from 'react-native-paper';

import { Note } from './components';
import { openPeers, teamSyncLine } from './syncLine';

export function TeamSettings() {
  const t = useSchemeTokens();
  const router = useRouter();
  const { installedAt } = useExtensionPrefs('team');
  const view = useTeamStore((s) => s.view);
  const teams = useTeamStore((s) => s.teams);
  const peers = useTeamStore((s) => s.peers);
  const meshRunning = useTeamStore((s) => s.meshRunning);
  const unread = useTeamStore((s) => s.unread);

  return (
    <ExtensionSettingsShell
      extKey="team"
      // The collapsed row's status: the open team and who is nearby.
      {...(view !== null
        ? {
            status:
              unread > 0
                ? `${view.name} · ${unread} unread`
                : `${view.name} · ${openPeers(peers).length} nearby`,
          }
        : {})}
      badge={undefined}
      badgeIcon="account-group"
      badgeIconSize={22}
      description="Share positions, waypoints and messages with your team — phone to phone, no server"
      legend={
        <Text variant="bodySmall" style={{ color: t.inkVariant }}>
          Invite by SMS, link or QR code. Works on the same Wi-Fi or a phone’s hotspot, with no cell
          signal. Teams end after 14 days unless extended.
        </Text>
      }
      note="Free · end-to-end encrypted · nothing goes through an Inukshuk server"
      showLabel="Team mode on"
      switchDescription={(on) =>
        on ? 'On · syncs with teammates nearby while the app is open' : 'Off · no team traffic'
      }
      removeDescription="Stops team mode; your teams stay on this phone"
      removeMessage="Team mode stops and nothing is shared. Your teams stay on this phone until you leave them, and come back if you get the extension again."
    >
      {installedAt > 0 && (
        <>
          {view !== null && (
            <List.Item
              title={view.name}
              description={`${view.activeCount} member${view.activeCount === 1 ? '' : 's'} · ${teamSyncLine(peers, meshRunning)}${unread > 0 ? ` · ${unread} unread` : ''}`}
              descriptionNumberOfLines={2}
              left={(p) => <List.Icon {...p} icon="account-group-outline" />}
              right={(p) => <List.Icon {...p} icon="chevron-right" />}
              onPress={() => router.push('/team')}
              testID="team-open-row"
            />
          )}
          {teams.length > 1 && (
            <List.Item
              title="Your teams"
              description={`${teams.length} teams on this phone`}
              left={(p) => <List.Icon {...p} icon="format-list-bulleted" />}
              right={(p) => <List.Icon {...p} icon="chevron-right" />}
              onPress={() => router.push('/team/teams')}
            />
          )}
          <List.Item
            title="Create a team"
            description="Name it, then invite people"
            left={(p) => <List.Icon {...p} icon="plus" />}
            onPress={() => router.push('/team/create')}
            testID="team-create-row"
          />
          <List.Item
            title="Join a team"
            description="Scan a QR code or paste an invite"
            left={(p) => <List.Icon {...p} icon="qrcode-scan" />}
            onPress={() => router.push('/team/join')}
            testID="team-join-row"
          />
          <View style={styles.note}>
            <Note icon="shield-lock-outline">
              Your position is shared only while you turn sharing on. A team lives only on its
              members’ phones, end-to-end encrypted.
            </Note>
          </View>
        </>
      )}
    </ExtensionSettingsShell>
  );
}

const styles = StyleSheet.create({
  note: { marginHorizontal: 16, marginVertical: 8 },
});
