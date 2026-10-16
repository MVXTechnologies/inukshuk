/**
 * Loopback builds only (`EXPO_PUBLIC_MESH_LOOPBACK=1`, dev and E2E): add
 * simulated phones to the in-memory mesh so the team flows run on one device
 * (Maestro). Never rendered in a store build.
 */
import { DEFAULT_INVITE } from '@core/teamui/invites';
import {
  addBadgeThreads,
  addSimulatedNote,
  addSimulatedTeammate,
  BADGE_THREADS,
  simulatedAlert,
  SIM_NOTE_TEXT,
  simulatedTeamToJoin,
} from '@data/team/simulatedTeammates';
import { teamService, useTeamStore } from '@state/teamStore';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Text } from '@ui/paper';
import { useScaledStyles } from '@ui/displayScale';

import { myPosition } from './bar/parts';

const NAMES = ['Julie Tremblay', 'Simon Gagnon', 'Ana Ruiz', 'Luc Bouchard'];
const QUEBEC = { latitude: 46.8139, longitude: -71.208 };

/**
 * Where the simulated phones act: this phone's freshest fix (the OS's last
 * known one), else the persisted last position, else Québec. Not the
 * persisted one first: it is written at most once a minute, from the first
 * fix after launch, so right after a location change (a Maestro flow's
 * `setLocation`) it still names the previous place, and a teammate's note
 * landed tens of km off screen.
 */
async function center(): Promise<{ latitude: number; longitude: number }> {
  const fix = await myPosition(null);
  if (fix !== null) return { latitude: fix[1], longitude: fix[0] };
  return useSettingsStore.getState().lastKnownPosition ?? QUEBEC;
}

export function SimulatedTeammates() {
  const styles = useScaledStyles(stylesSheet);

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
  // The teammate's note (#706) as THIS phone holds it.
  const noteHere = useTeamStore((s) =>
    s.pins.some((p) => p.note !== null && p.note.text === SIM_NOTE_TEXT),
  );
  const add = async () => {
    const session = teamService()?.active;
    if (!session) return;
    setBusy(true);
    const inv = session.createInvite(DEFAULT_INVITE);
    if (typeof inv !== 'string') {
      await addSimulatedTeammate(
        inv,
        NAMES[(count - 1) % NAMES.length] ?? 'Teammate',
        await center(),
      );
    }
    setBusy(false);
  };
  const addAlex = async () => {
    const session = teamService()?.active;
    if (!session) return;
    setBusy(true);
    const inv = session.createInvite(DEFAULT_INVITE);
    if (typeof inv !== 'string') {
      await addSimulatedTeammate(inv, 'Alex (Guide)', await center(), {
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
          void center()
            .then(addBadgeThreads)
            .finally(() => setBusy(false));
        }}
        loading={busy}
        testID="team-sim-badges"
      >
        Comment-badge threads (12, 100)
      </Button>
      <View style={styles.row}>
        <Button
          mode="outlined"
          onPress={() => void center().then((at) => simulatedAlert('rally', at))}
          testID="team-sim-rally"
        >
          They call a gather
        </Button>
        <Button
          mode="outlined"
          onPress={() => void center().then((at) => simulatedAlert('sos', at))}
          testID="team-sim-sos"
        >
          They raise an SOS
        </Button>
      </View>
      <Button
        mode="outlined"
        onPress={() => void center().then(addSimulatedNote)}
        testID="team-sim-note"
      >
        A teammate posts a note
      </Button>
      {noteHere && (
        <Text variant="bodySmall" testID="team-sim-note-done">
          The teammate’s note is on this phone
        </Text>
      )}
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
        void center()
          .then(simulatedTeamToJoin)
          .then((r) => {
            setBusy(false);
            if (r) onLink(r.link);
          });
      }}
    >
      Simulate a team nearby
    </Button>
  );
}

const stylesSheet = StyleSheet.create({
  box: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 12, padding: 12, gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
