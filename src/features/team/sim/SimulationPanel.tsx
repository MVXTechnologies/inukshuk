/**
 * The "Simulation" panel (demo builds only): start or stop a live team of
 * simulated teammates, ×1/×5, a message on demand, add a guest. Folded by
 * default at the bottom of the Team screen.
 */
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, List, Text } from 'react-native-paper';

import { ChoiceRow } from '../components';
import { teamSimulation, useSimStatus } from './teamSimulation';

export function SimulationPanel() {
  const t = useSchemeTokens();
  const [open, setOpen] = useState(false);
  const s = useSimStatus();
  return (
    <View style={[styles.wrap, { borderColor: t.outlineVariant }]} testID="team-sim-panel">
      <List.Item
        title="Simulation"
        description={
          s.busy ??
          (s.running
            ? `${s.bots.length} simulated teammates · ×${s.speed}${s.frameP95 !== null ? ` · frames p95 ${s.frameP95} ms, worst ${s.frameMax} ms` : ''}`
            : 'Stopped · a live team you can talk to (demo builds)')
        }
        left={(p) => <List.Icon {...p} icon="robot-outline" />}
        right={(p) => <List.Icon {...p} icon={open ? 'chevron-up' : 'chevron-down'} />}
        onPress={() => setOpen((o) => !o)}
        testID="team-sim-row"
      />
      {open && (
        <View style={styles.body}>
          <View style={styles.row}>
            {s.running ? (
              <Button
                mode="contained-tonal"
                icon="stop"
                onPress={() => void teamSimulation.stop()}
                testID="team-sim-stop"
              >
                Stop
              </Button>
            ) : (
              <Button
                mode="contained"
                icon="play"
                loading={s.busy !== null}
                disabled={s.busy !== null}
                onPress={() => void teamSimulation.start()}
                testID="team-sim-start"
              >
                Start
              </Button>
            )}
            <ChoiceRow
              options={[
                { id: 1, label: '×1' },
                { id: 5, label: '×5' },
              ]}
              value={s.speed}
              onChange={(v) => teamSimulation.setSpeed(v === 5 ? 5 : 1)}
              testIDPrefix="team-sim-speed"
            />
          </View>
          <Button
            mode="outlined"
            icon="message-text-outline"
            disabled={!s.running}
            onPress={() => teamSimulation.pokeMessage()}
            testID="team-sim-poke"
          >
            Make someone send a message now
          </Button>
          <Button
            mode="outlined"
            icon="account-plus-outline"
            disabled={!s.running || s.bots.some((b) => b.key === 'lea') || s.busy !== null}
            onPress={() => void teamSimulation.addGuest()}
            testID="team-sim-guest"
          >
            Add a guest
          </Button>
          <Button
            mode="outlined"
            icon="speedometer"
            disabled={!s.running}
            onPress={() => teamSimulation.stress(200)}
            testID="team-sim-stress"
          >
            Stress: 200 items
          </Button>
          <Text variant="bodySmall" style={{ color: t.inkVariant }}>
            Try: “+task @Sam check the bridge” on a photo, “@Julie t’es où?” in the chat, or + → Pin
            a team message on the map.
          </Text>
          {s.log.map((line, i) => (
            <Text key={i} variant="bodySmall" style={{ color: t.inkMuted }}>
              {line}
            </Text>
          ))}
          <Button mode="text" onPress={() => void teamSimulation.reset()} testID="team-sim-reset">
            Reset simulation
          </Button>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderWidth: 1, borderRadius: 12, marginTop: 8 },
  body: { paddingHorizontal: 16, paddingBottom: 12, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
});
