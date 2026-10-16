/**
 * The team's Connection screen (#705, mockup G7 screen 6), from Manage team
 * and from the Connection sheet's settings row:
 *
 * - **Nearby:** always on; "Connect by address" for hotspots that hide phones
 *   from each other (moved here from Manage team, owner 2026-10-16), and this
 *   phone's address.
 * - **Internet:** admins get the team's switch; members read it. "Always use
 *   the relay" (this phone) shows under it only while it is on — never as a
 *   greyed row (owner rule).
 * - **Nearby only until they update:** members whose app can't use it yet.
 */
import { MESH_DEFAULT_PORT, hotspotCandidates, isPrivateIPv4, parseIPv4 } from '@core/mesh/hotspot';
import { parseHostPort } from '@core/teamui/invites';
import { useSettingsStore } from '@state/settingsStore';
import { teamService, useTeamStore } from '@state/teamStore';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { Button, Icon, Switch, Text, TextInput } from '@ui/paper';

import { LinkChip, MemberAvatar, SectionLabel, TeamScreenFrame } from './components';
import { actionMessage } from './messages';
import { useScaledStyles, useDisplayScale } from '@ui/displayScale';

export function ConnectionScreen() {
  const { sz } = useDisplayScale();

  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const view = useTeamStore((s) => s.view);
  const net = useTeamStore((s) => s.net);
  const mesh = useTeamStore((s) => s.mesh);
  const meshRunning = useTeamStore((s) => s.meshRunning);
  const alwaysRelay = useSettingsStore((s) => s.teamAlwaysRelay);
  const [showDial, setShowDial] = useState(false);
  const [address, setAddress] = useState('');
  const session = teamService()?.active ?? null;

  if (view === null || session === null) {
    return (
      <TeamScreenFrame title="Connection" testID="team-connection-screen">
        <Text style={{ color: t.inkVariant }}>No team open.</Text>
      </TeamScreenFrame>
    );
  }

  const on = net?.on ?? false;
  const admin = view.isAdmin && !view.readOnly;
  const old = view.members.filter((m) => m.active && !m.isMe && net?.links.get(m.id) === 'old');

  const setInternet = (v: boolean) => {
    const err = session.setInternet(v);
    if (err !== null && err !== 'no-change') Alert.alert('Not done', actionMessage(err));
    useTeamStore.getState().refresh();
  };
  const dial = (host: string, port: number) => {
    if (!session.dial(host, port)) Alert.alert('Not connected', 'Team sync is off right now.');
    setShowDial(false);
  };
  const myAddress = meshRunning && mesh?.port != null ? myAddressLine(mesh.port) : '';

  return (
    <TeamScreenFrame title="Connection" testID="team-connection-screen">
      <SectionLabel>Nearby</SectionLabel>
      <Row
        icon="access-point"
        title="Same Wi-Fi or hotspot"
        line="Always on · no internet needed"
        right={<Icon source="check" size={20} color={t.status.gnssFixed} />}
      />
      <Row
        icon="lan-connect"
        title="Connect by address"
        line={
          myAddress === ''
            ? 'For hotspots that hide phones from each other'
            : `For hotspots that hide phones · ${myAddress}`
        }
        onPress={meshRunning ? () => setShowDial((v) => !v) : undefined}
        right={
          <Icon source={showDial ? 'chevron-up' : 'chevron-down'} size={20} color={t.inkMuted} />
        }
        testID="team-dial-open"
      />
      {showDial && (
        <View style={[styles.card, { backgroundColor: t.surfaceVariant }]}>
          <View style={styles.chips}>
            {hotspotCandidatesSafe().map((c) => (
              <Button key={c.host} mode="outlined" compact onPress={() => dial(c.host, c.port)}>
                {c.host}
              </Button>
            ))}
          </View>
          <TextInput
            returnKeyType="done"
            mode="outlined"
            dense
            label="Address (e.g. 172.20.10.1)"
            value={address}
            onChangeText={setAddress}
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            testID="team-dial-address"
          />
          <Button
            mode="contained"
            onPress={() => {
              const hp = parseHostPort(address, MESH_DEFAULT_PORT);
              if (hp === null) Alert.alert('Check the address', 'Four numbers like 192.168.1.20');
              else dial(hp.host, hp.port);
            }}
          >
            Connect
          </Button>
        </View>
      )}

      <SectionLabel>Internet</SectionLabel>
      <Row
        icon="web"
        title="Over the internet"
        line={
          admin
            ? on
              ? 'On for the whole team'
              : 'Off · only phones nearby sync'
            : on
              ? 'On for this team · set by its admins'
              : 'Off for this team · its admins can turn it on'
        }
        right={
          admin ? (
            <Switch
              value={on}
              onValueChange={setInternet}
              accessibilityLabel="Over the internet, for the whole team"
              testID="team-internet-switch"
            />
          ) : undefined
        }
        testID="team-internet-row"
      />
      {on && (
        <Row
          icon="shield-lock-outline"
          title="Always use the relay"
          line="Hides your IP address from teammates · a bit slower · this phone"
          right={
            <Switch
              value={alwaysRelay}
              onValueChange={(v) => useSettingsStore.getState().set('teamAlwaysRelay', v)}
              accessibilityLabel="Always use the relay"
              testID="team-always-relay-switch"
            />
          }
          testID="team-always-relay-row"
        />
      )}
      {on && old.length > 0 && (
        <>
          <SectionLabel>Nearby only until they update</SectionLabel>
          {old.map((m) => (
            <View key={m.id} style={styles.row} testID={`team-needs-update-${m.name}`}>
              <MemberAvatar initials={m.initials} color={m.color} size={sz(32)} />
              <Text
                variant="bodyMedium"
                style={[styles.flex, styles.title, { color: t.ink }]}
                numberOfLines={1}
              >
                {m.name}
              </Text>
              <LinkChip link="old" />
            </View>
          ))}
        </>
      )}
    </TeamScreenFrame>
  );
}

function Row({
  icon,
  title,
  line,
  right,
  onPress,
  testID,
}: {
  icon: string;
  title: string;
  line: string;
  right?: React.ReactNode;
  onPress?: () => void;
  testID?: string;
}) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const body = (
    <>
      <Icon source={icon} size={22} color={t.inkVariant} />
      <View style={styles.flex}>
        <Text variant="bodyLarge" style={[styles.title, { color: t.ink }]}>
          {title}
        </Text>
        <Text variant="bodySmall" style={{ color: t.inkVariant }}>
          {line}
        </Text>
      </View>
      {right}
    </>
  );
  return onPress ? (
    <Pressable onPress={onPress} style={styles.row} accessibilityRole="button" testID={testID}>
      {body}
    </Pressable>
  ) : (
    <View style={styles.row} testID={testID}>
      {body}
    </View>
  );
}

/** The hotspot's likely addresses (gateway, each private subnet's .1), best first. */
function hotspotCandidatesSafe(): { host: string; port: number }[] {
  const info = teamService()?.networkInfo() ?? null;
  return info ? hotspotCandidates(info).slice(0, 3) : [];
}

/** "this phone: 192.168.1.20" — what a teammate types when discovery is blocked. */
export function myAddressLine(port: number): string {
  const info = teamService()?.networkInfo() ?? null;
  const addr = info?.interfaces.find((i) => {
    const v = parseIPv4(i.address);
    return v !== null && isPrivateIPv4(v);
  })?.address;
  return addr ? `this phone: ${addr}${port === MESH_DEFAULT_PORT ? '' : `:${port}`}` : '';
}

const stylesSheet = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  title: { fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 52 },
  card: { borderRadius: 12, padding: 12, gap: space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
});
