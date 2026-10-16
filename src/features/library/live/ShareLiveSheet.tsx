import {
  INVITE_EXPIRY_PRESETS,
  INVITE_USE_PRESETS,
  type InviteExpiryId,
  type InviteUses,
} from '@core/teamui/invites';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';

import { LibrarySheet, SheetRow, sheetStyles } from '../selection/LibrarySheet';

/** What Share live starts with: who the invite makes, and how long and for how many it works. */
export interface ShareLiveChoice {
  canEdit: boolean;
  expiry: InviteExpiryId;
  uses: InviteUses;
}

export const DEFAULT_SHARE: ShareLiveChoice = { canEdit: true, expiry: '48h', uses: 5 };

/** "Works 48 hours · up to 5 people". */
export function inviteLine(c: Pick<ShareLiveChoice, 'expiry' | 'uses'>): string {
  const preset = INVITE_EXPIRY_PRESETS.find((p) => p.id === c.expiry);
  const who = c.uses === 1 ? 'one person' : `up to ${c.uses} people`;
  return `Works ${preset?.label ?? ''} · ${who}`;
}

/**
 * Share live (#712, revised mockup: a shared folder is its own group, apart
 * from team mode): what the people you invite can do (Edit by default, or
 * Only view) and how the invite works, then "Share and invite", which opens
 * the folder's own invite (QR or link).
 */
export function ShareLiveSheet({
  visible,
  focused,
  subtitle,
  busy,
  onStart,
  onClose,
}: {
  visible: boolean;
  focused: boolean;
  /** "Gaspésie 2026 · and anything added later", or the item's name. */
  subtitle: string;
  busy: boolean;
  onStart: (choice: ShareLiveChoice) => void;
  onClose: () => void;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  const [choice, setChoice] = useState<ShareLiveChoice>(DEFAULT_SHARE);
  const [inviteOpen, setInviteOpen] = useState(false);
  const set = (patch: Partial<ShareLiveChoice>) => setChoice((c) => ({ ...c, ...patch }));
  return (
    <LibrarySheet
      visible={visible}
      focused={focused}
      title="Share live"
      subtitle={subtitle}
      onClose={onClose}
      testID="library-share-live-sheet"
    >
      <Text style={[styles.label, { color: t.inkMuted }]}>PEOPLE YOU INVITE CAN</Text>
      <View style={[styles.seg, { borderColor: t.outline }]} accessibilityRole="radiogroup">
        {[
          { on: choice.canEdit, label: 'Edit', value: true },
          { on: !choice.canEdit, label: 'Only view', value: false },
        ].map((o, i) => (
          <Pressable
            key={o.label}
            onPress={() => set({ canEdit: o.value })}
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
      <SheetRow
        icon={<Icon source="clock-outline" size={22} color={t.ink} />}
        label="Invite"
        detail={
          <Text style={[sheetStyles.detail, { color: t.inkMuted }]}>{inviteLine(choice)}</Text>
        }
        trailing={
          <Icon source={inviteOpen ? 'chevron-up' : 'chevron-right'} size={24} color={t.inkMuted} />
        }
        onPress={() => setInviteOpen((o) => !o)}
        testID="share-live-invite-options"
      />
      {inviteOpen && (
        <View style={styles.options}>
          <Chips
            options={INVITE_EXPIRY_PRESETS.map((p) => ({ id: p.id, label: p.label }))}
            value={choice.expiry}
            onChange={(expiry) => set({ expiry })}
            testIDPrefix="share-live-expiry"
          />
          <Chips
            options={INVITE_USE_PRESETS.map((n) => ({
              id: n,
              label: n === 1 ? 'One person' : `${n} people`,
            }))}
            value={choice.uses}
            onChange={(uses) => set({ uses })}
            testIDPrefix="share-live-uses"
          />
        </View>
      )}
      <Pressable
        onPress={() => {
          if (!busy) onStart(choice);
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
          <Icon source="qrcode" size={20} color={theme.colors.onPrimary} />
        )}
        <Text style={[styles.startLabel, { color: theme.colors.onPrimary }]}>Share and invite</Text>
      </Pressable>
    </LibrarySheet>
  );
}

/** A row of choice chips (wrapping: nothing clips at 360 dp). */
export function Chips<T extends string | number>({
  options,
  value,
  onChange,
  testIDPrefix,
}: {
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  testIDPrefix: string;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  return (
    <View style={styles.chips} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable
            key={String(o.id)}
            onPress={() => onChange(o.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            testID={`${testIDPrefix}-${o.id}`}
            style={[
              styles.chip,
              { borderColor: t.outline },
              on && {
                backgroundColor: theme.colors.secondaryContainer,
                borderColor: theme.colors.secondaryContainer,
              },
            ]}
          >
            <Text style={[styles.chipLabel, { color: t.ink }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
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
    marginBottom: space.xs,
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
  options: { gap: space.sm, paddingHorizontal: 20, paddingBottom: space.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: {
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: 1,
    justifyContent: 'center',
  },
  chipLabel: { fontSize: 13.5, fontWeight: '700' },
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
