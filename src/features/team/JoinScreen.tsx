/**
 * Join a team (#589, spec §8.2): scan the invite QR, paste it, or arrive from
 * an `inukshuk://team/join?t=…` link (the SMS's web page hands it over).
 * Then my name, the search for a teammate's phone on this network (with the
 * hotspot fallback: the hotspot's likely addresses, or a typed one), and the
 * six-digit safety code to compare out loud before the team is kept.
 */
import { hotspotCandidates, MESH_DEFAULT_PORT } from '@core/mesh/hotspot';
import type { InviteToken } from '@core/team/invite';
import { parseAnyInvite, parseHostPort } from '@core/teamui/invites';
import { cleanName } from '@core/teamui/system';
import { MESH_LOOPBACK } from '@data/team';
import { JOIN_SEARCH_HINT_MS } from '@data/team/teamJoin';
import { installExtension } from '@features/extensions/actions';
import { setExtensionPrefs, useExtensionPrefs } from '@features/extensions/prefs';
import { reportError } from '@lib/errorReporting';
import { teamService, useTeamStore } from '@state/teamStore';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Linking, StyleSheet, View } from 'react-native';
import { Button, HelperText, Text, TextInput } from 'react-native-paper';

import { ActionBanner, Note, SectionLabel, TeamScreenFrame, useNow } from './components';
import { JOIN_FAILURE } from './messages';
import { loadQrScanner } from './QrScanner';
import { SimulatedTeamToJoin } from './SimulatedTeammates';

/** The camera scanner, or null on a binary without the camera module. */
const Scanner = loadQrScanner();

export function JoinScreen() {
  const t = useSchemeTokens();
  const router = useRouter();
  const params = useLocalSearchParams<{ t?: string }>();
  const join = useTeamStore((s) => s.join);
  const teams = useTeamStore((s) => s.teams);
  const lastName = teams.find((x) => x.myName)?.myName ?? '';
  const { installedAt, show } = useExtensionPrefs('team');
  // The link's invite, unless the user scanned or pasted another (or went back: null).
  const [picked, setToken] = useState<InviteToken | null | undefined>(undefined);
  const fromLink = useMemo(
    () => (params.t ? (parseAnyInvite(params.t) ?? null) : null),
    [params.t],
  );
  const token = picked === undefined ? fromLink : picked;
  const [paste, setPaste] = useState('');
  const [scanning, setScanning] = useState(false);
  const [myName, setMyName] = useState(lastName);
  const [address, setAddress] = useState('');
  const now = useNow(1000);

  // A link can arrive before the extension is installed: install it (free,
  // and the user just asked to join a team).
  useEffect(() => {
    if (installedAt === 0) installExtension('team');
    else if (!show) setExtensionPrefs('team', { show: true });
  }, [installedAt, show]);

  const service = teamService();
  if (service === null) {
    return (
      <TeamScreenFrame title="Join a team">
        <Note tone="warn">Team mode needs the latest Inukshuk. Update it from the store.</Note>
      </TeamScreenFrame>
    );
  }

  const already = token !== null && teams.some((x) => x.teamId === token.teamId);
  const expired = token !== null && token.expiresAt < now;

  const start = async () => {
    if (token === null) return;
    try {
      await service.startJoin(token, myName);
      useTeamStore.getState().refresh();
    } catch (e) {
      reportError(e, 'team-join-start');
      Alert.alert('Can’t join', (e as Error).message);
    }
  };
  const cancel = async () => {
    await service.cancelJoin();
    useTeamStore.getState().refresh();
  };
  const confirm = async () => {
    const r = await service.confirmJoin();
    useTeamStore.getState().refresh();
    if (typeof r === 'string') Alert.alert('Not joined', 'The team did not admit this phone.');
    else router.replace('/team');
  };
  const mismatch = () =>
    Alert.alert(
      'Codes don’t match',
      'Someone may be pretending to be your team. This phone forgets the team; ask the admin to remove the extra member and send you a new invite.',
      [{ text: 'OK', onPress: () => void cancel() }],
    );

  // ── Step 3: joining ───────────────────────────────────────────────────────
  if (join !== null) {
    if (join.phase === 'verify' && join.safetyCode !== null) {
      const code = join.safetyCode;
      return (
        <TeamScreenFrame title="Check the code" testID="team-join-verify">
          <Text variant="bodyLarge" style={[styles.center, { color: t.ink }]}>
            You’re in. Ask the person whose phone let you in to read their code.
          </Text>
          <Text
            style={[styles.code, { color: t.ink }]}
            testID="team-join-code"
            accessibilityLabel={`Safety code ${code.split('').join(' ')}`}
          >
            {code.slice(0, 3)} {code.slice(3)}
          </Text>
          <Text variant="bodySmall" style={[styles.center, { color: t.inkVariant }]}>
            The same six digits on both phones mean nobody is in between.
          </Text>
          <Button
            mode="contained"
            icon="check"
            onPress={() => void confirm()}
            testID="team-join-match"
          >
            The codes match
          </Button>
          <Button mode="outlined" onPress={mismatch} testID="team-join-mismatch">
            They don’t match
          </Button>
        </TeamScreenFrame>
      );
    }
    if (join.phase === 'failed' && join.failure !== null) {
      const f = JOIN_FAILURE[join.failure];
      return (
        <TeamScreenFrame title="Join a team" testID="team-join-failed">
          <ActionBanner
            icon="account-alert-outline"
            title={f.title}
            body={f.body}
            {...(join.failure === 'local-network-denied'
              ? { action: 'Settings', onAction: () => void Linking.openSettings() }
              : {})}
          />
          <Button mode="contained" onPress={() => void cancel()} testID="team-join-back">
            Back
          </Button>
        </TeamScreenFrame>
      );
    }
    const slow = now - join.startedAt > JOIN_SEARCH_HINT_MS;
    const candidates = (() => {
      const info = service.networkInfo();
      return info ? hotspotCandidates(info).slice(0, 3) : [];
    })();
    return (
      <TeamScreenFrame title="Joining…" testID="team-join-searching">
        <View style={styles.spinner}>
          <ActivityIndicator size="large" color={t.ink} />
          <Text variant="bodyLarge" style={[styles.center, { color: t.ink }]}>
            {join.phase === 'connecting'
              ? 'Connecting to the team…'
              : 'Looking for a teammate’s phone on this Wi-Fi or hotspot…'}
          </Text>
          <Text variant="bodySmall" style={[styles.center, { color: t.inkVariant }]}>
            A teammate’s Inukshuk must be open nearby, on the same network.
          </Text>
        </View>
        {(slow || join.hint !== null) && (
          <>
            <SectionLabel>On a hotspot?</SectionLabel>
            <Text variant="bodySmall" style={{ color: t.inkVariant }}>
              Some hotspots hide phones from each other. Try the hotspot itself, or type the address
              shown on a teammate’s team screen.
            </Text>
            <View style={styles.chips}>
              {candidates.map((c) => (
                <Button
                  key={c.host}
                  mode="outlined"
                  compact
                  onPress={() => service.join?.dial(c.host, c.port)}
                >
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
              testID="team-join-address"
            />
            <Button
              mode="outlined"
              onPress={() => {
                const hp = parseHostPort(address, MESH_DEFAULT_PORT);
                if (hp === null) Alert.alert('Check the address', 'Four numbers like 192.168.1.20');
                else service.join?.dial(hp.host, hp.port);
              }}
            >
              Connect
            </Button>
          </>
        )}
        {join.mesh?.localNetwork === 'denied' && (
          <ActionBanner
            icon="wifi-off"
            title="Local Network is off for Inukshuk"
            body="Turn it on in Settings › Privacy & Security › Local Network."
            action="Settings"
            onAction={() => void Linking.openSettings()}
          />
        )}
        <Button mode="text" onPress={() => void cancel()} testID="team-join-cancel">
          Cancel
        </Button>
      </TeamScreenFrame>
    );
  }

  // ── Step 2: an invite in hand ─────────────────────────────────────────────
  if (token !== null) {
    return (
      <TeamScreenFrame
        title="Join a team"
        testID="team-join-name"
        footer={
          <>
            <Button mode="text" onPress={() => setToken(null)}>
              Back
            </Button>
            <Button
              mode="contained"
              onPress={() => void start()}
              disabled={cleanName(myName) === null || already || expired}
              testID="team-join-start"
            >
              Join
            </Button>
          </>
        }
      >
        <Text variant="bodyLarge" style={{ color: t.ink }}>
          You have an invite to a team.
        </Text>
        <Text variant="bodySmall" style={{ color: t.inkVariant }}>
          Works until {new Date(token.expiresAt).toLocaleString()}
        </Text>
        {already && <Note tone="warn">You’re already in this team.</Note>}
        {expired && <Note tone="warn">This invite has expired. Ask for a new one.</Note>}
        <TextInput
          returnKeyType="done"
          mode="outlined"
          label="Your name in the team"
          value={myName}
          onChangeText={setMyName}
          maxLength={40}
          testID="team-join-myname"
        />
        <HelperText type="info" style={styles.helper}>
          Teammates see this name next to your messages and position.
        </HelperText>
        <Note icon="shield-lock-outline">
          Joining shares nothing until you choose to: your position is shared only when you turn
          sharing on.
        </Note>
      </TeamScreenFrame>
    );
  }

  // ── Step 1: get the invite ────────────────────────────────────────────────
  const usePaste = () => {
    const parsed = parseAnyInvite(paste);
    if (parsed === undefined)
      Alert.alert('Not an invite', 'Paste the whole link or code you received.');
    else setToken(parsed);
  };
  return (
    <TeamScreenFrame title="Join a team" testID="team-join-screen">
      {scanning && Scanner !== null ? (
        <Scanner
          onCode={(text) => {
            const parsed = parseAnyInvite(text);
            if (parsed) {
              setScanning(false);
              setToken(parsed);
            }
          }}
          onClose={() => setScanning(false)}
        />
      ) : (
        Scanner !== null && (
          <Button
            mode="contained"
            icon="qrcode-scan"
            onPress={() => setScanning(true)}
            testID="team-join-scan"
          >
            Scan the invite QR code
          </Button>
        )
      )}
      <SectionLabel>Or paste an invite</SectionLabel>
      <TextInput
        returnKeyType="done"
        mode="outlined"
        label="Invite link or code"
        value={paste}
        onChangeText={setPaste}
        autoCapitalize="none"
        autoCorrect={false}
        testID="team-join-paste"
      />
      <Button
        mode="outlined"
        onPress={usePaste}
        disabled={paste.trim().length === 0}
        testID="team-join-paste-go"
      >
        Continue
      </Button>
      <Note>
        Got an SMS? Tapping its link opens Inukshuk here. A team admin can make an invite from the
        team screen.
      </Note>
      {MESH_LOOPBACK && <SimulatedTeamToJoin onLink={(link) => setPaste(link)} />}
    </TeamScreenFrame>
  );
}

const styles = StyleSheet.create({
  center: { textAlign: 'center' },
  code: {
    fontSize: 48,
    lineHeight: 56,
    fontWeight: '800',
    letterSpacing: 6,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    marginVertical: space.lg,
  },
  spinner: { alignItems: 'center', gap: space.md, paddingVertical: space.xl },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  helper: { marginTop: -8, paddingHorizontal: 0 },
});
