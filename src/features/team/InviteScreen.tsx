/**
 * Invite people (#589, mockup `team-join`): an admin picks who the invite
 * makes (member or guest), how long it works and how many people may use it
 * — 48 h and single use by default (spec §15 #1) — and shows it as a QR code
 * in person, or sends it by SMS or any app as a link.
 *
 * The QR also carries this phone's address (QR only: never in an SMS or a
 * link), so a joiner finds the team on hotspots that hide phones from each
 * other.
 */
import {
  DEFAULT_INVITE,
  INVITE_EXPIRY_PRESETS,
  INVITE_USE_PRESETS,
  inviteSummary,
  smsInviteText,
  webJoinLink,
  type InviteChoice,
} from '@core/teamui/invites';
import type { CreatedInvite } from '@data/team/teamSession';
import { reportError } from '@lib/errorReporting';
import { teamService, useTeamStore } from '@state/teamStore';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Linking,
  Platform,
  Share,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Button, Switch, Text } from 'react-native-paper';

import { ChoiceRow, Note, SectionLabel, TeamScreenFrame } from './components';
import { actionMessage } from './messages';
import { QrCode } from './QrCode';

export function InviteScreen() {
  const t = useSchemeTokens();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const view = useTeamStore((s) => s.view);
  const [choice, setChoice] = useState<InviteChoice>(DEFAULT_INVITE);
  const [invite, setInvite] = useState<CreatedInvite | null>(null);
  const set = (patch: Partial<InviteChoice>) => setChoice((c) => ({ ...c, ...patch }));

  const create = () => {
    const session = teamService()?.active;
    if (!session) return;
    const result = session.createInvite(choice);
    if (typeof result === 'string') Alert.alert('No invite', actionMessage(result));
    else setInvite(result);
  };

  const teamName = view?.name ?? 'Team';
  const link = invite ? webJoinLink(invite.payload) : '';

  const sms = async () => {
    if (!invite) return;
    const body = encodeURIComponent(smsInviteText(teamName, invite.payload));
    // iOS reads `sms:&body=`, Android `sms:?body=`.
    const url = Platform.OS === 'ios' ? `sms:&body=${body}` : `sms:?body=${body}`;
    try {
      await Linking.openURL(url);
    } catch (e) {
      reportError(e, 'team-invite-sms');
      Alert.alert('No messaging app', 'Share the link instead.');
    }
  };

  return (
    <TeamScreenFrame title={invite ? 'Join code' : 'Invite people'} testID="team-invite-screen">
      {invite === null ? (
        <>
          <SectionLabel>They join as</SectionLabel>
          <ChoiceRow
            options={[
              { id: 'member', label: 'Member' },
              { id: 'guest', label: 'Guest' },
            ]}
            value={choice.role}
            onChange={(role) => set({ role })}
            testIDPrefix="team-invite-role"
          />
          <Text variant="bodySmall" style={{ color: t.inkVariant }}>
            {choice.role === 'guest'
              ? 'Guests see the team, share their position and post messages; they can’t edit shared waypoints.'
              : 'Members share positions, waypoints, trails and messages, and can let others in with an invite.'}
          </Text>
          <SectionLabel>Works for</SectionLabel>
          <ChoiceRow
            options={INVITE_EXPIRY_PRESETS.map((p) => ({ id: p.id, label: p.label }))}
            value={choice.expiry}
            onChange={(expiry) => set({ expiry })}
            testIDPrefix="team-invite-expiry"
          />
          <SectionLabel>How many people</SectionLabel>
          <ChoiceRow
            options={INVITE_USE_PRESETS.map((n) => ({ id: n, label: n === 1 ? 'One' : `${n}` }))}
            value={choice.uses}
            onChange={(uses) => set({ uses })}
            testIDPrefix="team-invite-uses"
          />
          <View style={styles.row}>
            <View style={styles.flex}>
              <Text variant="titleSmall" style={{ color: t.ink }}>
                An admin must let them in
              </Text>
              <Text variant="bodySmall" style={{ color: t.inkVariant }}>
                {choice.approve === 'admin'
                  ? 'They join only next to an admin’s phone'
                  : 'Any member’s phone nearby can let them in'}
              </Text>
            </View>
            <Switch
              value={choice.approve === 'admin'}
              onValueChange={(v) => set({ approve: v ? 'admin' : 'any' })}
              accessibilityLabel="An admin must let them in"
            />
          </View>
          <Button mode="contained" icon="qrcode" onPress={create} testID="team-invite-create">
            Create invite
          </Button>
          <Note icon="shield-lock-outline">
            Anyone holding the invite can join until it expires or is used up, so send it only to
            the people you mean. You can remove anyone later.
          </Note>
        </>
      ) : (
        <>
          <Text variant="bodyMedium" style={[styles.center, { color: t.inkVariant }]}>
            Ask them to scan this with Inukshuk (Settings › Extensions › Team mode › Join a team),
            on the same Wi-Fi or hotspot as you.
          </Text>
          <View style={styles.qr}>
            <QrCode
              text={invite.qrPayload}
              size={Math.min(280, width - 96)}
              testID="team-invite-qr"
            />
          </View>
          <Text
            variant="bodySmall"
            style={[styles.center, { color: t.inkMuted }]}
            testID="team-invite-summary"
          >
            {inviteSummary(choice)}
          </Text>
          <Text variant="bodySmall" style={[styles.center, { color: t.inkVariant }]}>
            When they join, both screens show the same six digits: compare them out loud.
          </Text>
          <View style={styles.buttons}>
            <Button
              mode="contained"
              icon="message-text-outline"
              onPress={() => void sms()}
              testID="team-invite-sms"
            >
              Send by SMS
            </Button>
            <Button
              mode="outlined"
              icon="share-variant-outline"
              onPress={() =>
                void Share.share({ message: smsInviteText(teamName, invite.payload) }).catch((e) =>
                  reportError(e, 'team-invite-share'),
                )
              }
              testID="team-invite-share"
            >
              Share link
            </Button>
            <Button
              mode="text"
              icon="content-copy"
              onPress={() => {
                void Clipboard.setStringAsync(link);
                Alert.alert('Link copied');
              }}
              testID="team-invite-copy"
            >
              Copy link
            </Button>
          </View>
          <Note icon="wifi">
            The QR also tells their phone where yours is on this network, for hotspots that hide
            phones from each other. SMS and links never carry it.
          </Note>
          <Button mode="text" onPress={() => router.back()} testID="team-invite-done">
            Done
          </Button>
        </>
      )}
    </TeamScreenFrame>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  center: { textAlign: 'center' },
  qr: { alignItems: 'center', paddingVertical: space.sm },
  buttons: { gap: space.sm },
});
