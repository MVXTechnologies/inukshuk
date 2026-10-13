/**
 * Pick mode (#589, owner 2026-10-07): "Attach to…" a trail point, a photo or
 * anywhere on the map, for a new task, a notify or a message pin. A clear
 * banner says what a tap does; the pick is confirmed (with its preview) before
 * it is used; "No location" skips it.
 */
import type { TaskAnchor } from '@core/team/tasks';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { Button, Icon, Text } from 'react-native-paper';
import { create } from 'zustand';

import { teamService, useTeamStore } from '@state/teamStore';

import { usePinDraft } from './TeamPinComposer';
import { useTeamSheet } from './teamMode';

export type PickPurpose = 'task' | 'notify' | 'pin' | 'rally';

export interface Picked {
  anchor: TaskAnchor;
  label: string;
  at: [number, number];
}

/** What New task had typed before it went to pick (kept while picking). */
export interface TaskDraft {
  title: string;
  assignee: string | null;
}

export const useTeamPick = create<{
  purpose: PickPurpose | null;
  picked: Picked | null;
  draft: TaskDraft | null;
  start: (purpose: PickPurpose, draft?: TaskDraft) => void;
  choose: (p: Picked) => void;
  again: () => void;
  cancel: () => void;
}>((set) => ({
  purpose: null,
  picked: null,
  draft: null,
  start: (purpose, draft) => set({ purpose, picked: null, draft: draft ?? null }),
  choose: (picked) => set({ picked }),
  again: () => set({ picked: null }),
  cancel: () => set({ purpose: null, picked: null }),
}));

const WHAT: Record<PickPurpose, string> = {
  task: 'Attach the task',
  notify: 'Notify about a place',
  pin: 'Pin a message',
  rally: 'Set the rally point',
};

/** Where a finished pick goes. */
export function usePickDone(): (p: Picked | null) => void {
  const router = useRouter();
  return (p) => {
    const { purpose } = useTeamPick.getState();
    useTeamPick.setState({ purpose: null, picked: null });
    if (purpose === 'task') {
      const a = p?.anchor;
      const q =
        a === undefined
          ? 'ak=none'
          : a.kind === 'point'
            ? `ak=point&la=${a.lat}&lo=${a.lng}`
            : `ak=${a.kind}&ao=${a.owner}&ai=${a.id}`;
      router.push(`/team/task-new?${q}&resume=1` as never);
    } else if (purpose === 'notify') {
      useTeamSheet.getState().open({ kind: 'notify', at: p ? p.at : null });
    } else if (purpose === 'pin' && p) {
      usePinDraft.getState().open(p.at[0], p.at[1]);
    } else if (purpose === 'rally' && p) {
      teamService()?.active?.setRally(p.at[0], p.at[1]);
      useTeamStore.getState().refresh();
    }
  };
}

/** The banner while picking, then the confirm card. */
export function TeamPickOverlay({ top, cardStyle }: { top: number; cardStyle: object }) {
  const t = useSchemeTokens();
  const purpose = useTeamPick((s) => s.purpose);
  const picked = useTeamPick((s) => s.picked);
  const done = usePickDone();
  if (purpose === null) return null;
  return (
    <>
      <View style={[styles.lane, { top }]} pointerEvents="box-none">
        <View
          style={[styles.banner, { backgroundColor: t.ink, shadowColor: palette.shadow }]}
          testID="team-pick-banner"
        >
          <Icon source="gesture-tap" size={20} color={t.background} />
          <Text variant="labelLarge" style={[styles.flex, { color: t.background }]}>
            {`${WHAT[purpose]}: tap a trail, a photo or the map`}
          </Text>
          <Button
            compact
            textColor={t.background}
            onPress={() => useTeamPick.getState().cancel()}
            testID="team-pick-cancel"
          >
            Cancel
          </Button>
        </View>
      </View>
      <View style={cardStyle} pointerEvents="box-none">
        <View
          style={[
            styles.card,
            { backgroundColor: t.elevation.level2, shadowColor: palette.shadow },
          ]}
          testID="team-pick-card"
        >
          {picked ? (
            <>
              <View style={styles.row}>
                <Icon source="map-marker-check" size={24} color={t.ink} />
                <Text
                  variant="titleSmall"
                  style={[styles.flex, { color: t.ink }]}
                  numberOfLines={2}
                >
                  {picked.label}
                </Text>
              </View>
              <View style={styles.row}>
                <Button
                  mode="outlined"
                  style={styles.flex}
                  onPress={() => useTeamPick.getState().again()}
                >
                  Pick again
                </Button>
                <Button
                  mode="contained"
                  style={styles.flex}
                  onPress={() => done(picked)}
                  testID="team-pick-use"
                >
                  Use this
                </Button>
              </View>
            </>
          ) : (
            <View style={styles.row}>
              <Text variant="bodyMedium" style={[styles.flex, { color: t.inkVariant }]}>
                Nothing picked yet
              </Text>
              {(purpose === 'task' || purpose === 'notify') && (
                <Button mode="text" onPress={() => done(null)} testID="team-pick-none">
                  No location
                </Button>
              )}
            </View>
          )}
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  lane: { position: 'absolute', left: 8, right: 8, zIndex: 9 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 14,
    paddingLeft: 12,
    paddingRight: 4,
    minHeight: 48,
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 5,
  },
  card: {
    borderRadius: 16,
    padding: 12,
    gap: 10,
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
