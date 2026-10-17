/**
 * Small building blocks of the team screens (#589): avatars, role chips,
 * notes and banners — the same restrained look as the GNSS screens (plain
 * themed Views, never Paper `Surface` for anything with internal flex:
 * paper-surface-ios-flex-collapse).
 */
import type { Role } from '@core/team/roles';
import { LINK_LABEL, type MemberLink } from '@core/teamui/links';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from '@ui/paper';
import { useScaledStyles } from '@ui/displayScale';

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
  const styles = useScaledStyles(stylesSheet);

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
  const styles = useScaledStyles(stylesSheet);

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

const LINK_ICON: Record<MemberLink, string> = {
  direct: 'swap-horizontal',
  relay: 'cloud-outline',
  nearby: 'access-point',
  connecting: 'dots-horizontal',
  old: 'cellphone-arrow-down',
  out: 'cloud-off-outline',
};

/** The link chip's text grows to this much of the font scale at most (a chip, like map chrome). */
export const LINK_FONT_CAP = 1.15;

/**
 * How a teammate is reached (#705): Direct (green), Relayed, Nearby,
 * Connecting, Needs update or Out of reach (amber). Small, and capped at
 * {@link LINK_FONT_CAP}, so a member's line still fits at 360 dp.
 */
export function LinkChip({ link }: { link: MemberLink }) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const color =
    link === 'direct'
      ? t.status.gnssFixed
      : link === 'out' || link === 'old'
        ? t.status.pausedInk
        : t.inkVariant;
  return (
    <View
      style={[styles.link, { backgroundColor: t.surfaceVariant }]}
      accessibilityLabel={LINK_LABEL[link]}
      testID={`team-link-${link}`}
    >
      <Icon source={LINK_ICON[link]} size={12} color={color} />
      <Text
        style={[styles.linkText, { color }]}
        maxFontSizeMultiplier={LINK_FONT_CAP}
        numberOfLines={1}
      >
        {LINK_LABEL[link]}
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
  const styles = useScaledStyles(stylesSheet);

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
  const styles = useScaledStyles(stylesSheet);

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

/** The one-line choice row's labels grow with the font scale up to this (#757). */
export const CHOICE_ONE_LINE_MAX_SCALE = 1.15;

/**
 * A segmented choice row ("Today · 3 days · 14 days · 30 days"). `oneLine`
 * (#757: the task filters) keeps every choice on one row in equal shares,
 * each label on one line beside its count, at up to 1.15× font: "Open 3".
 */
export function ChoiceRow<T extends string | number>({
  options,
  value,
  onChange,
  testIDPrefix,
  oneLine = false,
}: {
  options: readonly { id: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  testIDPrefix?: string;
  oneLine?: boolean;
}) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  if (oneLine) {
    return (
      <View
        style={[styles.choices, styles.choicesOneLine]}
        accessibilityRole="radiogroup"
        testID={testIDPrefix ? `${testIDPrefix}-row` : undefined}
      >
        {options.map((o) => {
          const on = o.id === value;
          const ink = on ? t.ink : t.inkVariant;
          return (
            <Pressable
              key={String(o.id)}
              onPress={() => onChange(o.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={o.count === undefined ? o.label : `${o.label}, ${o.count}`}
              testID={testIDPrefix ? `${testIDPrefix}-${o.id}` : undefined}
              style={[
                styles.choice,
                styles.choiceOneLine,
                {
                  borderColor: on ? t.ink : t.outlineVariant,
                  backgroundColor: on ? t.surfaceVariant : 'transparent',
                },
              ]}
            >
              <Text
                style={[styles.choiceTextOneLine, { color: ink }]}
                numberOfLines={1}
                maxFontSizeMultiplier={CHOICE_ONE_LINE_MAX_SCALE}
                testID={testIDPrefix ? `${testIDPrefix}-${o.id}-label` : undefined}
              >
                {o.label}
                {o.count !== undefined && (
                  <Text style={on ? styles.countOn : styles.countOff}>{` ${o.count}`}</Text>
                )}
              </Text>
            </Pressable>
          );
        })}
      </View>
    );
  }
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

const stylesSheet = StyleSheet.create({
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
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderRadius: 6,
    paddingLeft: 4,
    paddingRight: 6,
    paddingVertical: 1,
    flexShrink: 0,
  },
  linkText: { fontSize: 11, lineHeight: 14, fontWeight: '700' },
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
  choicesOneLine: { flexWrap: 'nowrap' },
  choiceOneLine: { flex: 1, minWidth: 0, justifyContent: 'center', paddingHorizontal: 6 },
  choiceTextOneLine: { fontSize: 13, fontWeight: '600' },
  countOn: { fontWeight: '800' },
  countOff: { fontWeight: '700', opacity: 0.8 },
});
