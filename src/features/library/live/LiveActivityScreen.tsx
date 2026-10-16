import type { ActivityLine, Part } from '@core/domains/library/liveView';
import { GnssScreenFrame } from '@features/extensions/gnss/GnssScreenFrame';
import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Snackbar, Text, useTheme } from 'react-native-paper';

import { LibrarySheet } from '../selection/LibrarySheet';
import { liveService, refreshLive, useLiveFolders } from './useLive';

/**
 * A shared folder's Activity (#712, G10 mockup 7): what needs a look pinned
 * on top in amber (Review: two versions; Restore: a delete beat an edit),
 * then every change by day, filterable by person. Managers also get the
 * mass-delete card (Restore all / Remove).
 */
export function LiveActivityScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = typeof id === 'string' ? id : '';
  const t = useSchemeTokens();
  const theme = useTheme();
  const list = useLiveFolders();
  const folder = list.find((f) => f.groupId === groupId);
  const [author, setAuthor] = useState<string | undefined>(undefined);
  const [review, setReview] = useState<{ kind: 'lfo' | 'lit'; id: string } | null>(null);
  const snack = useTimedSnackbar(4000);
  const live = liveService();
  const feed = useMemo(
    () => live?.activity(groupId, author),
    // Re-read whenever the folders change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live, groupId, author, list],
  );
  // Looking at Activity is what "to review" counts against.
  useEffect(() => {
    live?.markSeen(groupId);
  }, [live, groupId]);

  const nameOf = (memberId: string) =>
    folder?.people.find((p) => p.id === memberId)?.name ?? 'Someone';
  const act = (line: ActivityLine) => {
    const r = line.review;
    if (r === undefined || live === null) return;
    if (r.action === 'review') setReview({ kind: r.kind, id: r.id });
    else {
      const err = live.restore(groupId, r.kind, r.id);
      snack.show(err === null ? 'Restored' : 'Could not restore it');
      refreshLive();
    }
  };

  return (
    <GnssScreenFrame title="Activity" testID="live-activity-screen">
      {feed !== undefined && feed.people.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips}>
          {[undefined, ...feed.people].map((p) => {
            const on = author === p;
            return (
              <Pressable
                key={p ?? 'all'}
                onPress={() => setAuthor(p)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={[
                  styles.chip,
                  { borderColor: t.outlineVariant },
                  on && { backgroundColor: t.ink, borderColor: t.ink },
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.chipLabel, { color: on ? t.background : t.ink }]}
                >
                  {p === undefined ? 'All' : nameOf(p)}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}
      {folder?.massDelete.map((alert) => (
        <View
          key={alert.author}
          style={[styles.mass, { borderColor: theme.colors.error }]}
          testID="live-mass-delete"
        >
          <View style={styles.massHead}>
            <Icon source="delete-sweep-outline" size={20} color={theme.colors.error} />
            <Text style={[styles.massTitle, { color: t.ink }]}>
              {`${nameOf(alert.author)} deleted ${alert.count} items`}
            </Text>
          </View>
          <View style={styles.massActions}>
            <Pill
              primary
              label="Restore all"
              onPress={() => {
                live?.restoreAll(groupId, alert);
                refreshLive();
              }}
            />
            <Pill
              label={`Remove ${nameOf(alert.author)}`}
              onPress={() => {
                live?.remove(groupId, alert.author);
                refreshLive();
              }}
            />
          </View>
        </View>
      ))}
      {feed?.pinned.map((line) => (
        <Line key={line.key} line={line} pinned onAction={() => act(line)} who={nameOf} />
      ))}
      {feed?.days.map((day) => (
        <View key={day.label}>
          <Text style={[styles.day, { color: t.inkMuted }]} accessibilityRole="header">
            {day.label.toUpperCase()}
          </Text>
          {day.lines.map((line) => (
            <Line key={line.key} line={line} who={nameOf} />
          ))}
        </View>
      ))}
      {review !== null && (
        <ConflictSheet
          groupId={groupId}
          kind={review.kind}
          id={review.id}
          onClose={() => setReview(null)}
          onUsed={() => {
            setReview(null);
            refreshLive();
          }}
        />
      )}
      <Snackbar visible={snack.message !== null} onDismiss={snack.dismiss}>
        {snack.message ?? ''}
      </Snackbar>
    </GnssScreenFrame>
  );
}

function Pill({
  label,
  primary,
  onPress,
}: {
  label: string;
  primary?: boolean;
  onPress: () => void;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={[
        styles.pill,
        { borderColor: t.outline },
        primary && { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
      ]}
    >
      <Text style={[styles.pillLabel, { color: primary ? theme.colors.onPrimary : t.ink }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function Initials({ name }: { name: string }) {
  const t = useSchemeTokens();
  const ini =
    name === 'You'
      ? 'You'
      : name
          .split(/\s+/)
          .map((w) => w[0] ?? '')
          .join('')
          .slice(0, 2);
  return (
    <View style={[styles.avatar, { backgroundColor: t.surfaceVariant }]}>
      <Text style={[styles.avatarText, { color: t.ink }]}>{ini.toUpperCase()}</Text>
    </View>
  );
}

function Line({
  line,
  pinned,
  onAction,
  who,
}: {
  line: ActivityLine;
  pinned?: boolean;
  onAction?: () => void;
  who: (id: string) => string;
}) {
  const t = useSchemeTokens();
  const amber = t.status.pausedInk;
  return (
    <View
      style={[
        styles.line,
        { borderBottomColor: t.divider },
        pinned && { backgroundColor: t.surfaceVariant, borderLeftColor: amber, borderLeftWidth: 3 },
      ]}
      testID={pinned ? 'live-activity-pinned' : 'live-activity-line'}
    >
      <Initials name={who(line.author)} />
      <View style={styles.lineText}>
        <Text style={[styles.lineBody, { color: t.ink }]}>
          {line.parts.map((p: Part, i) => (
            <Text key={i} style={p.b ? styles.bold : undefined}>
              {p.t}
            </Text>
          ))}
        </Text>
        <Text style={[styles.when, { color: t.inkMuted }]}>{line.when}</Text>
      </View>
      {line.review !== undefined && onAction !== undefined && (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          testID={`live-activity-${line.review.action}`}
          style={[styles.lineButton, { borderColor: t.outline }]}
        >
          <Text style={[styles.lineButtonLabel, { color: t.ink }]}>
            {line.review.action === 'review' ? 'Review' : 'Restore'}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const FIELD_NAME: Record<string, string> = {
  n: 'Name',
  d: 'Description',
  ic: 'Icon',
  ll: 'Position',
  el: 'Elevation',
  sty: 'Style',
  g: 'Line',
  cat: 'Map',
};

/** Review a conflict (#712, G10 mockup 8): the later edit is Kept, Use this writes the other one again. */
export function ConflictSheet({
  groupId,
  kind,
  id,
  onClose,
  onUsed,
}: {
  groupId: string;
  kind: 'lfo' | 'lit';
  id: string;
  onClose: () => void;
  onUsed: () => void;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  const live = liveService();
  const c = live?.conflict(groupId, kind, id);
  if (c === undefined) return null;
  const show = (v: unknown): string =>
    typeof v === 'string'
      ? v
      : typeof v === 'number'
        ? String(v)
        : Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number')
          ? `${(v[1] as number).toFixed(4)}, ${(v[0] as number).toFixed(4)}`
          : 'Changed';
  return (
    <LibrarySheet
      visible
      focused
      title={c.name}
      subtitle={kind === 'lfo' ? 'Folder' : 'Item'}
      onClose={onClose}
      testID="live-conflict-sheet"
    >
      {c.conflicts.map((x) => (
        <View
          key={x.field}
          style={[
            styles.box,
            { borderColor: t.status.pausedInk, backgroundColor: t.surfaceVariant },
          ]}
        >
          <View style={styles.boxHead}>
            <Icon source="call-split" size={20} color={t.status.pausedInk} />
            <Text style={[styles.boxTitle, { color: t.status.pausedInk }]}>
              {`Two ${(FIELD_NAME[x.field] ?? x.field).toLowerCase()}s`}
            </Text>
          </View>
          <View style={[styles.version, { borderColor: theme.colors.primary, borderWidth: 2 }]}>
            <View style={styles.versionText}>
              <Text numberOfLines={2} style={[styles.versionValue, { color: t.ink }]}>
                {show(x.kept.value)}
              </Text>
              <Text style={[styles.when, { color: t.inkMuted }]}>{x.kept.who}</Text>
            </View>
            <Text style={[styles.kept, { color: theme.colors.primary }]}>KEPT</Text>
          </View>
          {x.others.map((o, i) => (
            <View key={i} style={[styles.version, { borderColor: t.outlineVariant }]}>
              <View style={styles.versionText}>
                <Text numberOfLines={2} style={[styles.versionValue, { color: t.ink }]}>
                  {show(o.value)}
                </Text>
                <Text style={[styles.when, { color: t.inkMuted }]}>{o.who}</Text>
              </View>
              <Pressable
                onPress={() => {
                  live?.keepVersion(groupId, kind, id, x.field, o.value);
                  onUsed();
                }}
                accessibilityRole="button"
                testID="live-conflict-use"
                style={[styles.use, { backgroundColor: theme.colors.secondaryContainer }]}
              >
                <Text style={[styles.lineButtonLabel, { color: t.ink }]}>Use this</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ))}
      {c.merges.length > 0 && (
        <>
          <Text style={[styles.day, { color: t.inkMuted, marginHorizontal: 20 }]}>ALSO MERGED</Text>
          {c.merges.flatMap((m) =>
            m.fields.map((f) => (
              <View
                key={`${m.who}-${f}`}
                style={[styles.kv, { borderBottomColor: t.outlineVariant }]}
              >
                <Text style={[styles.kvKey, { color: t.inkMuted }]}>{FIELD_NAME[f] ?? f}</Text>
                <Text numberOfLines={1} style={[styles.kvValue, { color: t.ink }]}>
                  {m.who}
                </Text>
              </View>
            )),
          )}
        </>
      )}
    </LibrarySheet>
  );
}

const styles = StyleSheet.create({
  chips: { flexGrow: 0, marginBottom: space.sm },
  chip: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 1,
    marginRight: space.sm,
    justifyContent: 'center',
  },
  chipLabel: { fontSize: 14.5, fontWeight: '800' },
  mass: { borderWidth: 1, borderRadius: 16, padding: space.md, marginBottom: space.sm },
  massHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  massTitle: { flex: 1, fontSize: 14, lineHeight: 19, fontWeight: '800' },
  massActions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  pill: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    justifyContent: 'center',
  },
  pillLabel: { fontSize: 13.5, fontWeight: '800' },
  day: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '800',
    letterSpacing: 1.1,
    marginTop: space.md,
    marginBottom: 2,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: 9,
    paddingHorizontal: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 11, fontWeight: '800' },
  lineText: { flex: 1, minWidth: 0 },
  lineBody: { fontSize: 14, lineHeight: 19, fontWeight: '600' },
  bold: { fontWeight: '800' },
  when: { fontSize: 12, lineHeight: 16, fontWeight: '700', marginTop: 1 },
  lineButton: {
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: 18,
    borderWidth: 1,
    justifyContent: 'center',
  },
  lineButtonLabel: { fontSize: 13, fontWeight: '800' },
  box: {
    borderWidth: 1,
    borderRadius: 16,
    padding: space.md,
    marginHorizontal: space.md,
    marginVertical: space.sm,
  },
  boxHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  boxTitle: { fontSize: 14, fontWeight: '800' },
  version: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.sm,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 6,
  },
  versionText: { flex: 1, minWidth: 0 },
  versionValue: { fontSize: 14.5, lineHeight: 19, fontWeight: '800' },
  kept: { fontSize: 11, fontWeight: '900', letterSpacing: 0.5 },
  use: { minHeight: 36, paddingHorizontal: space.md, borderRadius: 18, justifyContent: 'center' },
  kv: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.md,
    paddingVertical: 4,
    marginHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  kvKey: { fontSize: 13.5, fontWeight: '700' },
  kvValue: { flexShrink: 1, fontSize: 13.5, fontWeight: '600' },
});
