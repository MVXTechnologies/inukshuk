import type { PersonRow } from '@core/domains/library/liveView';
import type { Role } from '@core/team/roles';
import { GnssScreenFrame, SectionLabel } from '@features/extensions/gnss/GnssScreenFrame';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text, useTheme } from '@ui/paper';

import { LibrarySheet, SheetDivider, SheetRow, sheetStylesSheet } from '../selection/LibrarySheet';
import { liveService, refreshLive, useLiveFolders } from './useLive';
import { useScaledStyles } from '@ui/displayScale';

/**
 * A shared folder's People (#712, G10 mockup 9): everyone with their role,
 * then teammates a manager's phone will add. A manager taps a person for
 * their own sub-panel: Can edit / Can view, and Remove from folder.
 */
export function LivePeopleScreen() {
  const sheetStyles = useScaledStyles(sheetStylesSheet);

  const styles = useScaledStyles(stylesSheet);

  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = typeof id === 'string' ? id : '';
  const t = useSchemeTokens();
  const folder = useLiveFolders().find((f) => f.groupId === groupId);
  const [person, setPerson] = useState<PersonRow | null>(null);
  const people = folder?.people ?? [];
  const live = liveService();
  const router = useRouter();
  return (
    <GnssScreenFrame title="People" testID="live-people-screen">
      {folder !== undefined && (
        <SectionLabel>{`${folder.name} · ${people.filter((p) => !p.pending).length} people`}</SectionLabel>
      )}
      {people.map((p) => {
        const opens = folder?.canManage === true && !p.isMe && !p.pending && p.role !== 'owner';
        return (
          <Pressable
            key={p.id}
            disabled={!opens}
            onPress={() => setPerson(p)}
            accessibilityRole={opens ? 'button' : undefined}
            testID={`live-person-${p.pending ? 'pending' : p.isMe ? 'me' : 'member'}`}
            style={[styles.row, person?.id === p.id && { backgroundColor: t.surfaceVariant }]}
          >
            <View
              style={[
                styles.avatar,
                { backgroundColor: t.surfaceVariant, opacity: p.pending ? 0.6 : 1 },
              ]}
            >
              <Text style={[styles.avatarText, { color: t.ink }]}>{initials(p.name)}</Text>
            </View>
            <View style={styles.text}>
              <Text numberOfLines={1} style={[styles.name, { color: t.ink }]}>
                {p.name}
              </Text>
              <Text style={[sheetStyles.detail, { color: t.inkMuted }]}>{p.detail}</Text>
            </View>
            {opens && <Icon source="chevron-right" size={24} color={t.inkMuted} />}
          </Pressable>
        );
      })}
      {folder?.canManage === true && (
        <Pressable
          onPress={() => router.push({ pathname: '/shared/[id]/invite', params: { id: groupId } })}
          accessibilityRole="button"
          testID="live-people-invite"
          style={[styles.row, styles.invite, { borderTopColor: t.outlineVariant }]}
        >
          <View style={[styles.avatar, { backgroundColor: t.surfaceVariant }]}>
            <Icon source="qrcode" size={22} color={t.ink} />
          </View>
          <View style={styles.text}>
            <Text style={[styles.name, { color: t.ink }]}>Invite people</Text>
            <Text style={[sheetStyles.detail, { color: t.inkMuted }]}>QR code or link</Text>
          </View>
          <Icon source="chevron-right" size={24} color={t.inkMuted} />
        </Pressable>
      )}
      <PersonSheet
        person={person}
        folderName={folder?.name ?? ''}
        onRole={(role) => {
          if (person === null) return;
          live?.setRole(groupId, person.id, role);
          setPerson(null);
          refreshLive();
        }}
        onRemove={() => {
          if (person === null) return;
          live?.remove(groupId, person.id);
          setPerson(null);
          refreshLive();
        }}
        onClose={() => setPerson(null)}
      />
    </GnssScreenFrame>
  );
}

function initials(name: string): string {
  if (name === 'You') return 'You';
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** One person's sub-panel: their role as two radio rows, and Remove from folder. */
export function PersonSheet({
  person,
  folderName,
  onRole,
  onRemove,
  onClose,
}: {
  person: PersonRow | null;
  folderName: string;
  onRole: (role: Role) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const sheetStyles = useScaledStyles(sheetStylesSheet);

  const t = useSchemeTokens();
  const theme = useTheme();
  const role = person?.role;
  const radio = (on: boolean) => (
    <Icon
      source={on ? 'radiobox-marked' : 'radiobox-blank'}
      size={24}
      color={on ? theme.colors.primary : t.inkMuted}
    />
  );
  const detail = (s: string) => (
    <Text style={[sheetStyles.detail, { color: t.inkMuted }]}>{s}</Text>
  );
  return (
    <LibrarySheet
      visible={person !== null}
      focused
      title={person?.name ?? ''}
      subtitle={folderName}
      onClose={onClose}
      testID="live-person-sheet"
    >
      <SheetRow
        accent={role !== 'guest'}
        icon={radio(role !== 'guest')}
        label="Can edit"
        detail={detail('Add, rename, move and delete')}
        onPress={() => onRole('member')}
        testID="live-person-edit"
      />
      <SheetRow
        accent={role === 'guest'}
        icon={radio(role === 'guest')}
        label="Can view"
        detail={detail('Sees every change')}
        onPress={() => onRole('guest')}
        testID="live-person-view"
      />
      <SheetDivider />
      <SheetRow
        icon={<Icon source="account-remove-outline" size={22} color={theme.colors.error} />}
        label="Remove from folder"
        detail={detail(`Stops syncing on ${person?.name ?? 'their'}’s phone`)}
        onPress={onRemove}
        testID="live-person-remove"
      />
    </LibrarySheet>
  );
}

const stylesSheet = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 56,
    paddingVertical: 6,
    paddingHorizontal: space.xs,
    borderRadius: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 13, fontWeight: '800' },
  text: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  invite: {
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    marginTop: space.sm,
    paddingTop: space.sm,
  },
});
