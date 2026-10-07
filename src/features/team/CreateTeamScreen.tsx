/**
 * New team (#589, mockup `team-create`): a name, my display name and how
 * long the team lasts (14 days by default, owner B6; extendable later). The
 * creator becomes the organizer (owner). Invites come next, from the team.
 */
import {
  DEFAULT_LIFETIME,
  LIFETIME_PRESETS,
  lifetimeMs,
  type LifetimeId,
} from '@core/teamui/lifetime';
import { cleanName } from '@core/teamui/system';
import { setExtensionPrefs, useExtensionPrefs } from '@features/extensions/prefs';
import { ensureTeamNotifications } from '@data/team/teamNotifications';
import { reportError } from '@lib/errorReporting';
import { teamService, useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, HelperText, Text, TextInput } from 'react-native-paper';

import { ChoiceRow, Note, SectionLabel, TeamScreenFrame } from './components';

export function CreateTeamScreen() {
  const t = useSchemeTokens();
  const router = useRouter();
  const lastName = useTeamStore((s) => s.teams.find((x) => x.myName)?.myName ?? '');
  const { show } = useExtensionPrefs('team');
  const [name, setName] = useState('');
  const [myName, setMyName] = useState(lastName);
  const [lifetime, setLifetime] = useState<LifetimeId>(DEFAULT_LIFETIME);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = cleanName(name) !== null && cleanName(myName) !== null && !busy;

  const create = async () => {
    const service = teamService();
    if (service === null || !ready) return;
    setBusy(true);
    setError(null);
    try {
      await service.createTeam({ name, myName, lifetimeMs: lifetimeMs(lifetime) });
      if (!show) setExtensionPrefs('team', { show: true });
      void ensureTeamNotifications();
      useTeamStore.getState().refresh();
      router.replace('/team');
    } catch (e) {
      reportError(e, 'team-create');
      setError((e as Error).message || 'Could not create the team');
      setBusy(false);
    }
  };

  return (
    <TeamScreenFrame
      title="New team"
      testID="team-create-screen"
      footer={
        <>
          <Button mode="text" onPress={() => router.back()}>
            Cancel
          </Button>
          <Button
            mode="contained"
            onPress={() => void create()}
            disabled={!ready}
            loading={busy}
            testID="team-create-submit"
          >
            Create team
          </Button>
        </>
      }
    >
      <TextInput
        returnKeyType="done"
        mode="outlined"
        label="Team name"
        value={name}
        onChangeText={setName}
        maxLength={40}
        placeholder="Relevé sentiers · Mont-Sainte-Anne"
        testID="team-create-name"
        autoFocus
      />
      <TextInput
        returnKeyType="done"
        mode="outlined"
        label="Your name in the team"
        value={myName}
        onChangeText={setMyName}
        maxLength={40}
        testID="team-create-myname"
      />
      <HelperText type="info" style={styles.helper}>
        Teammates see this name next to your messages and position.
      </HelperText>
      <SectionLabel>Ends</SectionLabel>
      <ChoiceRow
        options={LIFETIME_PRESETS.map((p) => ({ id: p.id, label: p.label }))}
        value={lifetime}
        onChange={setLifetime}
        testIDPrefix="team-create-ends"
      />
      <Text variant="bodySmall" style={{ color: t.inkVariant }}>
        An admin can extend it, up to a year. After it ends the team turns read-only.
      </Text>
      {error !== null && (
        <HelperText type="error" visible>
          {error}
        </HelperText>
      )}
      <View style={styles.gap} />
      <Note icon="shield-lock-outline">
        The team lives only on its members’ phones, end-to-end encrypted. You’re its organizer: you
        and the admins you choose manage who’s in it.
      </Note>
    </TeamScreenFrame>
  );
}

const styles = StyleSheet.create({
  helper: { marginTop: -8, paddingHorizontal: 0 },
  gap: { height: 4 },
});
