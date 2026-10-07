/**
 * Small building blocks of the team screens (#589): avatars, role chips,
 * notes and banners — the same restrained look as the GNSS screens (plain
 * themed Views, never Paper `Surface` for anything with internal flex:
 * paper-surface-ios-flex-collapse).
 */
import type { Role } from '@core/team/roles';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

export {
  GnssScreenFrame as TeamScreenFrame,
  SectionLabel,
} from '@features/extensions/gnss/GnssScreenFrame';

/** The wall clock, re-read every `periodMs` (ages and expiry lines). */
export function useNow(periodMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(id);
  }, [periodMs]);
  return now;
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Organizer',
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
};

export function MemberAvatar({
  initials,
  color,
  size = 40,
  online,
  dim,
}: {
  initials: string;
  color: string;
  size?: number;
  /** A small presence dot: true = connected now, false = away, undefined = none. */
  online?: boolean;
  dim?: boolean;
}) {
  const t = useSchemeTokens();
  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        dim && styles.dim,
      ]}
      accessible={false}
    >
      <Text style={[styles.initials, { fontSize: size * 0.38, color: t.team.onAvatar }]}>
        {initials}
      </Text>
      {online !== undefined && (
        <View
          style={[
            styles.presence,
            {
              backgroundColor: online ? t.status.gnssFixed : t.inkMuted,
              borderColor: t.background,
            },
          ]}
        />
      )}
    </View>
  );
}

export function RoleChip({ role, left }: { role: Role; left?: boolean }) {
  const t = useSchemeTokens();
  const strong = role === 'owner' || role === 'admin';
  return (
    <View
      style={[
        styles.chip,
        {
          borderColor: left ? t.status.pausedInk : strong ? t.ink : t.outlineVariant,
          backgroundColor: strong ? t.surfaceVariant : 'transparent',
        },
      ]}
    >
      <Text style={[styles.chipText, { color: left ? t.status.pausedInk : t.inkVariant }]}>
        {left ? 'Left' : ROLE_LABEL[role]}
      </Text>
    </View>
  );
}

/** A rounded info box (privacy statements, hints). */
export function Note({
  icon = 'information-outline',
  children,
  tone = 'info',
  testID,
}: {
  icon?: string;
  children: ReactNode;
  tone?: 'info' | 'warn';
  testID?: string;
}) {
  const t = useSchemeTokens();
  return (
    <View style={[styles.note, { backgroundColor: t.surfaceVariant }]} testID={testID}>
      <Icon source={icon} size={18} color={tone === 'warn' ? t.status.pausedInk : t.inkVariant} />
      <View style={styles.flex}>
        {typeof children === 'string' ? (
          <Text variant="bodySmall" style={{ color: tone === 'warn' ? t.ink : t.inkVariant }}>
            {children}
          </Text>
        ) : (
          children
        )}
      </View>
    </View>
  );
}

/** A tappable banner with an action ("Rotate now", "Open Settings"). */
export function ActionBanner({
  icon,
  title,
  body,
  action,
  onAction,
  testID,
}: {
  icon: string;
  title: string;
  body?: string;
  action?: string;
  onAction?: () => void;
  testID?: string;
}) {
  const t = useSchemeTokens();
  return (
    <View
      style={[
        styles.banner,
        { backgroundColor: t.surfaceVariant, borderColor: t.status.pausedInk },
      ]}
      testID={testID}
    >
      <Icon source={icon} size={20} color={t.status.pausedInk} />
      <View style={styles.flex}>
        <Text variant="titleSmall" style={{ color: t.ink }}>
          {title}
        </Text>
        {body !== undefined && (
          <Text variant="bodySmall" style={{ color: t.inkVariant }}>
            {body}
          </Text>
        )}
      </View>
      {action !== undefined && onAction !== undefined && (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          style={[styles.bannerButton, { borderColor: t.ink }]}
          hitSlop={8}
        >
          <Text style={[styles.bannerButtonText, { color: t.ink }]}>{action}</Text>
        </Pressable>
      )}
    </View>
  );
}

/** A segmented choice row ("Today · 3 days · 14 days · 30 days"). */
export function ChoiceRow<T extends string | number>({
  options,
  value,
  onChange,
  testIDPrefix,
}: {
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  testIDPrefix?: string;
}) {
  const t = useSchemeTokens();
  return (
    <View style={styles.choices} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable
            key={String(o.id)}
            onPress={() => onChange(o.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={o.label}
            testID={testIDPrefix ? `${testIDPrefix}-${o.id}` : undefined}
            style={[
              styles.choice,
              {
                borderColor: on ? t.ink : t.outlineVariant,
                backgroundColor: on ? t.surfaceVariant : 'transparent',
              },
            ]}
          >
            {on && <Icon source="check" size={14} color={t.ink} />}
            <Text style={[styles.choiceText, { color: on ? t.ink : t.inkVariant }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  dim: { opacity: 0.45 },
  initials: { fontWeight: '700' },
  presence: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
  },
  chip: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  chipText: { fontSize: 12, fontWeight: '600' },
  note: {
    flexDirection: 'row',
    gap: 10,
    padding: 12,
    borderRadius: 12,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 12,
    borderLeftWidth: 3,
  },
  bannerButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  bannerButtonText: { fontSize: 13, fontWeight: '700' },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minHeight: 40,
  },
  choiceText: { fontSize: 14, fontWeight: '600' },
});
