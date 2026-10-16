import { DEVICE_EXTENSIONS } from '@core/extensions/registry';
import {
  TEAM_PRIVACY_NOTE,
  TeamCreateOption,
  TeamJoinOption,
  TeamYourTeamsOption,
  useSharePosition,
} from '@features/team/options';
import { teamSyncLine } from '@features/team/syncLine';
import { selectChatUnread, useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { Button, Icon, Text } from '@ui/paper';

import {
  SheetNote,
  SubPanelHeader,
  SwitchRow,
  useSheetAccent,
} from '../../map/components/mapSheet';
import { setExtensionPrefs, useExtensionPrefs } from '../prefs';
import type { ExtensionSubPanelProps } from '../types';
import { useScaledStyles } from '@ui/displayScale';

/**
 * Map overlays › Extensions › Team mode (#668): the open team's card (into
 * the hub, Invite for admins), "Share my position" (the hub's switch, the
 * same `prefs.sharePosition`), "Taps signal the team" (the extension's
 * switch, its real meaning), then the Settings rows: your teams, create,
 * join. With no team, the card says so and Create and Join come first.
 */
export function TeamSubPanel({ onBack, onClose }: ExtensionSubPanelProps) {
  const styles = useScaledStyles(stylesSheet);

  const tokens = useSchemeTokens();
  const { accent, onAccent } = useSheetAccent();
  const router = useRouter();
  const { show } = useExtensionPrefs('team');
  const view = useTeamStore((s) => s.view);
  const peers = useTeamStore((s) => s.peers);
  const meshRunning = useTeamStore((s) => s.meshRunning);
  const unread = useTeamStore(selectChatUnread);
  const share = useSharePosition();
  const { label } = DEVICE_EXTENSIONS.team;

  const go = (href: '/team' | '/team/invite') => {
    onClose();
    router.push(href);
  };

  const join = (
    <>
      <TeamCreateOption variant="sheet" onLeave={onClose} />
      <TeamJoinOption variant="sheet" onLeave={onClose} />
    </>
  );

  return (
    <>
      <SubPanelHeader title={label} backLabel="Back to extensions" onBack={onBack} />
      <View style={[styles.card, { backgroundColor: tokens.surfaceVariant }]}>
        <View style={styles.cardTop}>
          <Icon source="account-group-outline" size={24} color={tokens.inkVariant} />
          <View style={styles.flex}>
            <Text style={[styles.cardTitle, { color: tokens.ink }]} numberOfLines={1}>
              {view !== null ? view.name : 'No team yet'}
            </Text>
            <Text style={[styles.cardLine, { color: tokens.inkMuted }]} numberOfLines={2}>
              {view !== null
                ? `${view.activeCount} member${view.activeCount === 1 ? '' : 's'} · ${teamSyncLine(peers, meshRunning)}${unread > 0 ? ` · ${unread} unread` : ''}`
                : 'Create one, or join with an invite'}
            </Text>
          </View>
        </View>
        {view !== null && (
          <View style={styles.cardButtons}>
            <Button
              mode="contained"
              icon="forum-outline"
              compact
              buttonColor={accent}
              textColor={onAccent}
              onPress={() => go('/team')}
            >
              Open team hub
            </Button>
            {view.isAdmin && !view.readOnly && (
              <Button
                mode="outlined"
                icon="account-plus-outline"
                compact
                textColor={tokens.ink}
                onPress={() => go('/team/invite')}
              >
                Invite
              </Button>
            )}
          </View>
        )}
      </View>
      {view === null && join}
      {share !== null && (
        <SwitchRow
          icon="share-variant-outline"
          label="Share my position"
          hint="Teammates see you on their map"
          value={share.on}
          onToggle={() => share.set(!share.on)}
          accessibilityLabel="Share my position with the team"
        />
      )}
      <SwitchRow
        icon="gesture-tap"
        label="Taps signal the team"
        hint="A map tap offers “Signal here”"
        value={show}
        onToggle={() => setExtensionPrefs('team', { show: !show })}
      />
      <TeamYourTeamsOption variant="sheet" onLeave={onClose} />
      {view !== null && join}
      <SheetNote icon="shield-lock-outline">{TEAM_PRIVACY_NOTE}</SheetNote>
    </>
  );
}

const stylesSheet = StyleSheet.create({
  card: { marginHorizontal: 16, marginTop: 4, marginBottom: 8, padding: 12, borderRadius: 14 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardTitle: { fontSize: 16, lineHeight: 21, fontWeight: '800' },
  cardLine: { fontSize: 12.5, lineHeight: 16 },
  cardButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  flex: { flex: 1 },
});
