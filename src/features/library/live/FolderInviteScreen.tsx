/**
 * A shared folder's own invite (#712, revised mockup): a QR code to scan in
 * person, or a link to send (SMS or any app). It works wherever they are:
 * the folder meets them nearby or through its own room. Who it makes and
 * how long it works are this invite's own options (changing one makes a new
 * invite).
 */
import {
  INVITE_EXPIRY_PRESETS,
  INVITE_USE_PRESETS,
  smsInviteText,
  type InviteChoice,
  type InviteExpiryId,
  type InviteUses,
} from '@core/teamui/invites';
import type { CreatedInvite } from '@data/team/teamSession';
import { GnssScreenFrame } from '@features/extensions/gnss/GnssScreenFrame';
import { QrCode } from '@features/team/QrCode';
import { reportError } from '@lib/errorReporting';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Linking,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { Icon, Text } from '@ui/paper';

import { sheetStylesSheet } from '../selection/LibrarySheet';
import { Chips, inviteLine } from './ShareLiveSheet';
import { useLiveFolders } from './useLive';
import { appLibraryBridge } from '@data/sync/libraryPort';
import { useScaledStyles } from '@ui/displayScale';

const EXPIRY_IDS = INVITE_EXPIRY_PRESETS.map((p) => p.id) as readonly string[];

function choiceFrom(params: Record<string, string | undefined>): InviteChoice {
  const expiry = (
    EXPIRY_IDS.includes(params['expiry'] ?? '') ? params['expiry'] : '48h'
  ) as InviteExpiryId;
  const n = Number(params['uses']);
  const uses = ((INVITE_USE_PRESETS as readonly number[]).includes(n) ? n : 5) as InviteUses;
  return { expiry, uses, role: params['role'] === 'guest' ? 'guest' : 'member', approve: 'any' };
}

export function FolderInviteScreen() {
  const styles = useScaledStyles(stylesSheet);

  const params = useLocalSearchParams<{
    id: string;
    role?: string;
    expiry?: string;
    uses?: string;
  }>();
  const groupId = typeof params.id === 'string' ? params.id : '';
  const t = useSchemeTokens();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const folder = useLiveFolders().find((f) => f.groupId === groupId);
  const make = (c: InviteChoice): CreatedInvite | null => {
    const r = appLibraryBridge()?.groups.invite(groupId, c);
    return r === undefined || typeof r === 'string' ? null : r;
  };
  const [choice, setChoiceState] = useState<InviteChoice>(() => choiceFrom(params));
  // Made once on opening, and again whenever its options change (each is its own `i.create`).
  const [invite, setInvite] = useState<CreatedInvite | null>(() => make(choiceFrom(params)));
  const failed = invite === null;
  const setChoice = (update: (c: InviteChoice) => InviteChoice) => {
    const next = update(choice);
    setChoiceState(next);
    setInvite(make(next));
  };
  const [open, setOpen] = useState<'role' | 'works' | null>(null);
  const name = folder?.name ?? 'the folder';

  const sms = async () => {
    if (invite === null) return;
    const body = encodeURIComponent(smsInviteText(name, invite.payload));
    const url = Platform.OS === 'ios' ? `sms:&body=${body}` : `sms:?body=${body}`;
    try {
      await Linking.openURL(url);
    } catch (e) {
      reportError(e, 'folder-invite-sms');
    }
  };
  const link = async () => {
    if (invite === null) return;
    try {
      await Share.share({ message: smsInviteText(name, invite.payload) });
    } catch (e) {
      reportError(e, 'folder-invite-share');
    }
  };

  return (
    <GnssScreenFrame title={`Invite to ${name}`} testID="folder-invite-screen">
      {failed && (
        <Text style={[styles.center, { color: t.inkVariant }]}>
          Only a manager of the folder can invite people.
        </Text>
      )}
      {invite !== null && (
        <>
          <View style={styles.qr}>
            <QrCode
              text={invite.qrPayload}
              size={Math.min(240, width - 96)}
              testID="folder-invite-qr"
            />
            <Text style={[styles.caption, { color: t.inkMuted }]} testID="folder-invite-summary">
              {`Scan with Inukshuk · ${inviteLine(choice).replace(/^Works/, 'works')}`}
            </Text>
          </View>
          <View style={styles.buttons}>
            <Button
              icon="link-variant"
              label="Send link"
              onPress={() => void link()}
              testID="folder-invite-link"
            />
            <Button
              icon="message-text-outline"
              label="SMS"
              onPress={() => void sms()}
              testID="folder-invite-sms"
            />
          </View>
        </>
      )}
      <View style={[styles.card, { borderColor: t.outlineVariant, backgroundColor: t.surface }]}>
        <Row
          icon="account-plus-outline"
          label="They can"
          detail={choice.role === 'guest' ? 'Only view' : 'Edit'}
          open={open === 'role'}
          onPress={() => setOpen((o) => (o === 'role' ? null : 'role'))}
          testID="folder-invite-role"
        />
        {open === 'role' && (
          <View style={styles.sub}>
            <Chips
              options={[
                { id: 'member', label: 'Edit' },
                { id: 'guest', label: 'Only view' },
              ]}
              value={choice.role}
              onChange={(role) => setChoice((c) => ({ ...c, role }))}
              testIDPrefix="folder-invite-role"
            />
          </View>
        )}
        <Row
          icon="clock-outline"
          label="Works for"
          detail={inviteLine(choice).replace(/^Works /, '')}
          open={open === 'works'}
          onPress={() => setOpen((o) => (o === 'works' ? null : 'works'))}
          testID="folder-invite-works"
        />
        {open === 'works' && (
          <View style={styles.sub}>
            <Chips
              options={INVITE_EXPIRY_PRESETS.map((p) => ({ id: p.id, label: p.label }))}
              value={choice.expiry}
              onChange={(expiry) => setChoice((c) => ({ ...c, expiry }))}
              testIDPrefix="folder-invite-expiry"
            />
            <Chips
              options={INVITE_USE_PRESETS.map((n) => ({
                id: n,
                label: n === 1 ? 'One person' : `${n} people`,
              }))}
              value={choice.uses}
              onChange={(uses) => setChoice((c) => ({ ...c, uses }))}
              testIDPrefix="folder-invite-uses"
            />
          </View>
        )}
      </View>
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        style={styles.done}
        testID="folder-invite-done"
      >
        <Text style={[styles.doneLabel, { color: t.ink }]}>Done</Text>
      </Pressable>
    </GnssScreenFrame>
  );
}

function Button({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        { borderColor: t.outline },
        pressed && { backgroundColor: t.surfaceVariant },
      ]}
    >
      <Icon source={icon} size={20} color={t.ink} />
      <Text numberOfLines={1} style={[styles.buttonLabel, { color: t.ink }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function Row({
  icon,
  label,
  detail,
  open,
  onPress,
  testID,
}: {
  icon: string;
  label: string;
  detail: string;
  open: boolean;
  onPress: () => void;
  testID: string;
}) {
  const sheetStyles = useScaledStyles(sheetStylesSheet);

  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      testID={testID}
      style={styles.row}
    >
      <View style={[styles.tile, { backgroundColor: t.surfaceVariant }]}>
        <Icon source={icon} size={22} color={t.ink} />
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: t.ink }]}>{label}</Text>
        <Text style={[sheetStyles.detail, { color: t.inkMuted }]}>{detail}</Text>
      </View>
      <Icon source={open ? 'chevron-up' : 'chevron-right'} size={24} color={t.inkMuted} />
    </Pressable>
  );
}

const stylesSheet = StyleSheet.create({
  center: { textAlign: 'center' },
  qr: { alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  caption: { textAlign: 'center', fontSize: 13, lineHeight: 18, fontWeight: '700' },
  buttons: { flexDirection: 'row', gap: space.sm },
  button: {
    flex: 1,
    minHeight: 48,
    borderRadius: 24,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm,
  },
  buttonLabel: { fontSize: 15, fontWeight: '800', flexShrink: 1 },
  card: { borderWidth: 1, borderRadius: 18, overflow: 'hidden', marginTop: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56, padding: space.sm },
  tile: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  sub: { gap: space.sm, paddingHorizontal: space.md, paddingBottom: space.sm },
  done: {
    alignSelf: 'center',
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  doneLabel: { fontSize: 15, fontWeight: '800' },
});
