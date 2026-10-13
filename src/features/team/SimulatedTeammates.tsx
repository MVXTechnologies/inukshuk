/**
 * Loopback builds only (`EXPO_PUBLIC_MESH_LOOPBACK=1`, dev and E2E): add
 * simulated phones to the in-memory mesh so the team flows run on one device
 * (Maestro). Never rendered in a store build.
 */
import { DEFAULT_INVITE } from '@core/teamui/invites';
import {
  addBadgeThreads,
  addSimulatedTeammate,
  BADGE_THREADS,
  simulatedTeamToJoin,
} from '@data/team/simulatedTeammates';
import { teamService, useTeamStore } from '@state/teamStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Text } from 'react-native-paper';

const NAMES = ['Julie Tremblay', 'Simon Gagnon', 'Ana Ruiz', 'Luc Bouchard'];
const QUEBEC = { latitude: 46.8139, longitude: -71.208 };

function center() {
  return useSettingsStore.getState().lastKnownPosition ?? QUEBEC;
}

export function SimulatedTeammates() {
  const t = useSchemeTokens();
  const [busy, setBusy] = useState(false);
  const count = useTeamStore((s) => s.view?.activeCount ?? 0);
  // The badge threads as THIS phone holds them (synced, not just written).
  const badgesHere = useTeamStore((s) =>
    BADGE_THREADS.every(({ caption, comments }) => {
      const photo = s.photos.find((p) => p.caption === caption);
      return photo !== undefined && (s.photoThreads.get(photo.id)?.length ?? 0) >= comments;
    }),
  );
  const add = async () => {
    const session = teamService()?.active;
    if (!session) return;
    setBusy(true);
    const inv = session.createInvite(DEFAULT_INVITE);
    if (typeof inv !== 'string') {
      await addSimulatedTeammate(inv, NAMES[(count - 1) % NAMES.length] ?? 'Teammate', center());
    }
    setBusy(false);
  };
  const addAlex = async () => {
    const session = teamService()?.active;
    if (!session) return;
    setBusy(true);
    const inv = session.createInvite(DEFAULT_INVITE);
    if (typeof inv !== 'string') {
      await addSimulatedTeammate(inv, 'Alex (Guide)', center(), {
        photoComment: 'Superbe vue au sommet ! On repart à 14 h?',
      });
    }
    setBusy(false);
  };
  return (
    <View style={[styles.box, { borderColor: t.outlineVariant }]}>
      <Text variant="labelSmall" style={{ color: t.inkMuted }}>
        LOOPBACK BUILD · SIMULATED PHONES
      </Text>
      <Button mode="outlined" onPress={() => void add()} loading={busy} testID="team-sim-add">
        Add a simulated teammate
      </Button>
      <Button mode="outlined" onPress={() => void addAlex()} loading={busy} testID="team-sim-alex">
        Add Alex (Guide) · comments on shared photos
      </Button>
      <Button
        mode="outlined"
        onPress={() => {
          setBusy(true);
          void addBadgeThreads(center()).finally(() => setBusy(false));
        }}
        loading={busy}
        testID="team-sim-badges"
      >
        Comment-badge threads (12, 100)
      </Button>
      {badgesHere && (
        <Text variant="bodySmall" testID="team-sim-badges-done">
          Badge threads synced to this phone
        </Text>
      )}
    </View>
  );
}

/** On the Join screen: a simulated team to join (its invite link). */
export function SimulatedTeamToJoin({ onLink }: { onLink: (link: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      mode="outlined"
      loading={busy}
      testID="team-sim-team"
      onPress={() => {
        setBusy(true);
        void simulatedTeamToJoin(center()).then((r) => {
          setBusy(false);
          if (r) onLink(r.link);
        });
      }}
    >
      Simulate a team nearby
    </Button>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 12, padding: 12, gap: 8 },
});
