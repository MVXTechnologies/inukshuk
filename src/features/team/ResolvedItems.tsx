/**
 * Resolved messages (#589, owner 2026-10-07): pins and directed messages
 * marked done leave the map, the chat and the unread counts and sit in the
 * task list's "Done" view, below the completed tasks; nothing is deleted, and
 * each can be opened again.
 */
import { canResolve } from '@core/teamui/pins';
import { teamService, useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { StyleSheet, View } from 'react-native';
import { Button, Text } from 'react-native-paper';

import { MemberAvatar, SectionLabel } from './components';

export function ResolvedItems() {
  const t = useSchemeTokens();
  const view = useTeamStore((s) => s.view);
  const pins = useTeamStore((s) => s.pins);
  const resolved = useTeamStore((s) => s.resolved);
  if (view === null) return null;
  const byId = new Map(view.members.map((m) => [m.id, m]));
  const rows = [
    ...pins
      .filter((p) => resolved.has(`${p.owner}:${p.id}`))
      .map((p) => ({
        key: `${p.owner}:${p.id}`,
        owner: p.owner,
        id: p.id,
        kind: 'Pin',
        text: p.messages[0]?.text ?? '',
        at: p.lastAt,
        mentions: p.messages[0]?.mentions ?? [],
      })),
    ...view.messages
      .filter((m) => resolved.has(m.key))
      .map((m) => {
        const [owner = '', id = ''] = m.key.split(':');
        return {
          key: m.key,
          owner,
          id,
          kind: 'Message',
          text: m.text,
          at: m.at,
          mentions: m.mentionsMe ? [view.me] : [],
        };
      }),
  ].sort((a, b) => b.at - a.at);
  return (
    <View style={styles.group} testID="team-resolved-list">
      <SectionLabel>{`Resolved messages · ${rows.length}`}</SectionLabel>
      {rows.length === 0 && (
        <Text variant="bodySmall" style={{ color: t.inkVariant }}>
          None yet. Mark a pin or a message done with its check.
        </Text>
      )}
      {rows.map((r) => {
        const m = byId.get(r.owner);
        const may = canResolve({ author: r.owner, mentions: r.mentions }, view.me, view.isAdmin);
        return (
          <View key={r.key} style={[styles.row, { backgroundColor: t.surfaceVariant }]}>
            <MemberAvatar initials={m?.initials ?? '?'} color={m?.color ?? t.inkMuted} size={30} />
            <View style={styles.flex}>
              <Text variant="labelMedium" style={{ color: t.inkMuted }}>
                {`${r.kind} · ${m?.name ?? 'A teammate'}`}
              </Text>
              <Text variant="bodyMedium" style={{ color: t.ink }} numberOfLines={2}>
                {r.text}
              </Text>
            </View>
            {may && (
              <Button
                compact
                onPress={() => {
                  teamService()?.active?.resolveMessage(r.owner, r.id, false);
                  useTeamStore.getState().refresh();
                }}
              >
                Reopen
              </Button>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 2 },
  group: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12 },
});
