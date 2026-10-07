/**
 * Collaborative trail editing (#589, mockup v2 e, approved). While a team
 * trail is being edited the map's taps edit it:
 * - tap a point to select it; with one selected, tap anywhere to move it there;
 * - tap the line between two points to insert one there;
 * - Extend, then tap: a new point after the nearest end;
 * - Delete removes the selected point; Undo reverts my own last edit.
 * Changes sync live (signed ops; `records.ts` merges them). Others see an
 * "is editing" cue. An edit that can't be applied says so (never silently).
 */
import type { TrailVertex } from '@core/team/records';
import { insertKey, nearestSegment, nearestVertex, type TeamTrailView } from '@core/teamui/trails';
import { teamService, useTeamStore } from '@state/teamStore';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, IconButton, Text, TextInput } from 'react-native-paper';
import { create } from 'zustand';

import { actionMessage } from '../messages';

type Ref = { owner: string; id: string };
type Undo =
  | { kind: 'move'; v: TrailVertex }
  | { kind: 'insert'; id: string }
  | { kind: 'delete'; v: TrailVertex };

export const useTrailEdit = create<{
  trail: Ref | null;
  selected: string | null;
  extend: boolean;
  undo: Undo[];
  error: string | null;
}>(() => ({ trail: null, selected: null, extend: false, undo: [], error: null }));

const NO_ROOM = 'No room for a point there: delete a neighbour, then add it again.';

export function startEditing(trail: Ref): void {
  useTrailEdit.setState({ trail, selected: null, extend: false, undo: [], error: null });
  teamService()?.active?.setEditing(trail);
}

export function stopEditing(): void {
  useTrailEdit.setState({ trail: null, selected: null, extend: false, undo: [], error: null });
  teamService()?.active?.setEditing(null);
}

function current(): TeamTrailView | undefined {
  const t = useTrailEdit.getState().trail;
  return t
    ? useTeamStore.getState().teamTrails.find((x) => x.owner === t.owner && x.id === t.id)
    : undefined;
}

function done(
  err: string | null,
  undo?: Undo,
  extra: Partial<{ selected: string | null; extend: boolean }> = {},
) {
  useTeamStore.getState().refresh();
  const s = useTrailEdit.getState();
  useTrailEdit.setState({
    error: err,
    undo: err === null && undo ? [...s.undo.slice(-49), undo] : s.undo,
    ...extra,
  });
}

/** A map tap while editing. Returns false when it wasn't about the trail. */
export function editTap(at: [number, number], tolM: number): boolean {
  const session = teamService()?.active;
  const trail = current();
  const st = useTrailEdit.getState();
  if (!session || !trail || st.trail === null) return false;
  const vs = trail.vertices;
  if (st.extend) {
    // After the nearer end.
    const first = vs[0];
    const last = vs[vs.length - 1];
    if (!first || !last) return true;
    const dFirst = Math.hypot(first.lng - at[0], first.lat - at[1]);
    const dLast = Math.hypot(last.lng - at[0], last.lat - at[1]);
    const index = dLast <= dFirst ? vs.length - 1 : -1;
    const key = insertKey(vs, index);
    if (key === null) return (done(NO_ROOM), true);
    const r = session.insertVertex(st.trail, key, at[0], at[1]);
    if (typeof r === 'string') done(actionMessage(r));
    else done(null, { kind: 'insert', id: r.id }, { selected: r.id });
    return true;
  }
  const hit = nearestVertex(vs, at, tolM);
  if (hit) {
    useTrailEdit.setState({ selected: hit.id === st.selected ? null : hit.id, error: null });
    return true;
  }
  if (st.selected !== null) {
    const v = vs.find((x) => x.id === st.selected);
    if (!v) return (useTrailEdit.setState({ selected: null }), true);
    const err = session.moveVertex(st.trail, v.id, at[0], at[1], v.inserted ? v.key : undefined);
    done(err ? actionMessage(err) : null, { kind: 'move', v }, { selected: null });
    return true;
  }
  const seg = nearestSegment(vs, at, tolM);
  if (seg) {
    const key = insertKey(vs, seg.index);
    if (key === null) return (done(NO_ROOM), true);
    const r = session.insertVertex(st.trail, key, seg.point[0], seg.point[1]);
    if (typeof r === 'string') done(actionMessage(r));
    else done(null, { kind: 'insert', id: r.id }, { selected: r.id });
    return true;
  }
  useTrailEdit.setState({ selected: null });
  return true;
}

function deleteSelected(): void {
  const session = teamService()?.active;
  const st = useTrailEdit.getState();
  const v = current()?.vertices.find((x) => x.id === st.selected);
  if (!session || !st.trail || !v) return;
  if ((current()?.vertices.length ?? 0) <= 2) return done('A trail keeps at least two points.');
  const err = session.deleteVertex(st.trail, v.id);
  done(err ? actionMessage(err) : null, { kind: 'delete', v }, { selected: null });
}

function undoLast(): void {
  const session = teamService()?.active;
  const st = useTrailEdit.getState();
  const u = st.undo[st.undo.length - 1];
  if (!session || !st.trail || !u) return;
  let err: string | null = null;
  if (u.kind === 'insert') err = session.deleteVertex(st.trail, u.id);
  else
    err = session.moveVertex(
      st.trail,
      u.v.id,
      u.v.lng,
      u.v.lat,
      u.v.inserted ? u.v.key : undefined,
    );
  useTrailEdit.setState({ undo: st.undo.slice(0, -1), error: err ? actionMessage(err) : null });
  useTeamStore.getState().refresh();
}

/** The editing toolbar (compact, bottom). */
export function TrailEditBar({ style }: { style: object }) {
  const t = useSchemeTokens();
  const st = useTrailEdit();
  const trails = useTeamStore((s) => s.teamTrails);
  const editors = useTeamStore((s) => s.editors);
  const view = useTeamStore((s) => s.view);
  const [naming, setNaming] = useState<string | null>(null);
  if (st.trail === null || view === null) return null;
  const trail = trails.find((x) => x.owner === st.trail!.owner && x.id === st.trail!.id);
  const key = `${st.trail.owner}:${st.trail.id}`;
  const others = [...editors]
    .filter(([m, k]) => k === key && m !== view.me)
    .map(([m]) => view.members.find((x) => x.id === m)?.name.split(' ')[0] ?? 'A teammate');
  const tool = (icon: string, label: string, onPress: () => void, on = true, testID?: string) => (
    <Pressable
      key={label}
      onPress={on ? onPress : undefined}
      disabled={!on}
      style={styles.tool}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !on }}
      testID={testID}
    >
      <View
        style={[
          styles.toolBtn,
          { backgroundColor: label === 'Done' ? t.ink : t.surfaceVariant, opacity: on ? 1 : 0.4 },
        ]}
      >
        <Icon source={icon} size={22} color={label === 'Done' ? t.background : t.ink} />
      </View>
      <Text variant="labelSmall" style={{ color: t.ink }}>
        {label}
      </Text>
    </Pressable>
  );
  return (
    <View style={style} pointerEvents="box-none">
      <View
        style={[styles.card, { backgroundColor: t.elevation.level2, shadowColor: palette.shadow }]}
        testID="team-trail-editor"
      >
        <View style={styles.row}>
          <Icon source="vector-polyline-edit" size={22} color={t.ink} />
          <View style={styles.flex}>
            <Text variant="titleSmall" style={{ color: t.ink }} numberOfLines={1}>
              {`Editing · ${trail?.name ?? 'Trail'}${others.length ? ` · ${others.join(', ')} too` : ''}`}
            </Text>
            <Text
              variant="bodySmall"
              style={{ color: st.error ? t.status.gpsLostInk : t.inkVariant }}
              numberOfLines={2}
            >
              {st.error ??
                (st.extend
                  ? 'Tap where the trail goes next'
                  : st.selected
                    ? 'Tap where this point goes, or Delete'
                    : 'Tap a point to move it · tap the line to add one')}
            </Text>
          </View>
        </View>
        {naming !== null ? (
          <View style={styles.row}>
            <TextInput
              mode="outlined"
              dense
              style={styles.flex}
              value={naming}
              onChangeText={setNaming}
              maxLength={80}
              returnKeyType="done"
              onSubmitEditing={() => {
                const err = teamService()?.active?.editTrailMeta(st.trail!, { name: naming });
                done(err ? actionMessage(err) : null);
                setNaming(null);
              }}
              testID="team-trail-name"
            />
            <IconButton icon="close" onPress={() => setNaming(null)} accessibilityLabel="Cancel" />
          </View>
        ) : (
          <View style={styles.tools}>
            {tool('undo', 'Undo', undoLast, st.undo.length > 0, 'team-trail-undo')}
            {tool(
              'vector-point-minus',
              'Delete',
              deleteSelected,
              st.selected !== null,
              'team-trail-delete',
            )}
            {tool(
              'arrow-expand-right',
              st.extend ? 'Extending' : 'Extend',
              () => useTrailEdit.setState({ extend: !st.extend, selected: null }),
              true,
              'team-trail-extend',
            )}
            {tool(
              'rename-box',
              'Name',
              () => setNaming(trail?.name ?? ''),
              true,
              'team-trail-rename',
            )}
            {tool('check', 'Done', stopEditing, true, 'team-trail-done')}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  card: {
    borderRadius: 16,
    padding: 12,
    gap: 10,
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  tools: { flexDirection: 'row', justifyContent: 'space-between' },
  tool: { alignItems: 'center', gap: 4, minWidth: 56 },
  toolBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
