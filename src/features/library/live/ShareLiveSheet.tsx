import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';

import { LibrarySheet, SheetRow, sheetStyles } from '../selection/LibrarySheet';

/** One of my teams, as the sheet lists it. */
export interface ShareTeam {
  id: string;
  name: string;
  people: number;
}

export type ShareWith = { team: string } | { newGroup: true };

/**
 * Share live (#712, G10 mockup 4): with one of my teams (its people are added
 * at once, and whoever joins it later) or a new group (QR invite); everyone
 * added can edit, or only view. Reached from the Share sheet's "Share live".
 */
export function ShareLiveSheet({
  visible,
  focused,
  subtitle,
  teams,
  allowNewGroup = false,
  busy,
  onStart,
  onClose,
}: {
  visible: boolean;
  focused: boolean;
  /** "Gaspésie 2026 · and anything added later", or the item's name. */
  subtitle: string;
  teams: readonly ShareTeam[];
  /** Offer "New group" (QR invite); off until the invite flow takes a shared folder. */
  allowNewGroup?: boolean;
  busy: boolean;
  onStart: (choice: { with: ShareWith; canEdit: boolean }) => void;
  onClose: () => void;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  const [pick, setPick] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(true);
  const chosen = pick ?? teams[0]?.id ?? 'new';
  const radio = (on: boolean) => (
    <Icon
      source={on ? 'radiobox-marked' : 'radiobox-blank'}
      size={24}
      color={on ? theme.colors.primary : t.inkMuted}
    />
  );
  const detail = (text: string) => (
    <Text style={[sheetStyles.detail, { color: t.inkMuted }]}>{text}</Text>
  );
  return (
    <LibrarySheet
      visible={visible}
      focused={focused}
      title="Share live"
      subtitle={subtitle}
      onClose={onClose}
      testID="library-share-live-sheet"
    >
      <Text style={[styles.label, { color: t.inkMuted }]}>WITH</Text>
      {teams.map((team) => (
        <SheetRow
          key={team.id}
          accent={chosen === team.id}
          icon={<Icon source="account-group" size={24} color={t.ink} />}
          label={team.name}
          detail={detail(
            `Team · ${team.people} ${team.people === 1 ? 'person' : 'people'} · and who joins later`,
          )}
          trailing={radio(chosen === team.id)}
          onPress={() => setPick(team.id)}
          accessibilityLabel={`With ${team.name}`}
          testID={`share-live-team-${team.id}`}
        />
      ))}
      {allowNewGroup && (
        <SheetRow
          accent={chosen === 'new'}
          icon={<Icon source="qrcode" size={24} color={t.ink} />}
          label="New group"
          detail={detail('Invite people with a QR code')}
          trailing={radio(chosen === 'new')}
          onPress={() => setPick('new')}
          testID="share-live-new-group"
        />
      )}
      <Text style={[styles.label, { color: t.inkMuted }]}>THEY CAN</Text>
      <View style={[styles.seg, { borderColor: t.outline }]} accessibilityRole="radiogroup">
        {[
          { on: canEdit, label: 'Edit', value: true },
          { on: !canEdit, label: 'Only view', value: false },
        ].map((o, i) => (
          <Pressable
            key={o.label}
            onPress={() => setCanEdit(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: o.on }}
            testID={`share-live-role-${o.value ? 'edit' : 'view'}`}
            style={[
              styles.segItem,
              i > 0 && { borderLeftWidth: 1, borderLeftColor: t.outline },
              o.on && { backgroundColor: theme.colors.secondaryContainer },
            ]}
          >
            {o.on && <Icon source="check" size={16} color={t.ink} />}
            <Text numberOfLines={1} style={[styles.segLabel, { color: t.ink }]}>
              {o.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        onPress={() => {
          if (busy) return;
          onStart({ with: chosen === 'new' ? { newGroup: true } : { team: chosen }, canEdit });
        }}
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        testID="share-live-start"
        style={({ pressed }) => [
          styles.start,
          { backgroundColor: theme.colors.primary },
          (pressed || busy) && styles.pressed,
        ]}
      >
        {busy ? (
          <ActivityIndicator color={theme.colors.onPrimary} accessibilityLabel="Sharing" />
        ) : (
          <Icon source="sync" size={20} color={theme.colors.onPrimary} />
        )}
        <Text style={[styles.startLabel, { color: theme.colors.onPrimary }]}>Start sharing</Text>
      </Pressable>
    </LibrarySheet>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '800',
    letterSpacing: 1.1,
    marginTop: space.md,
    marginBottom: space.xs,
    marginHorizontal: 20,
  },
  seg: {
    flexDirection: 'row',
    minHeight: 44,
    marginHorizontal: 20,
    borderWidth: 1,
    borderRadius: 22,
    overflow: 'hidden',
  },
  segItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: space.xs,
  },
  segLabel: { fontSize: 14, fontWeight: '700', flexShrink: 1 },
  start: {
    minHeight: 48,
    borderRadius: 24,
    marginTop: space.lg,
    marginHorizontal: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
  },
  startLabel: { fontSize: 15.5, fontWeight: '800' },
  pressed: { opacity: 0.7 },
});
