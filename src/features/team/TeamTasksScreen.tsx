/**
 * The task list (#589, mockup `d-task-list`; owner 2026-10-07: it replaces
 * "Resolved"): open tasks first; filters (open, mine, all, done), grouped by
 * person (me first), each with where it is anchored, when it is due, its age
 * and who gave it; the box ticks it (creator, assignee or admin), the locate
 * button flies the map to its anchor. "Done" also lists the resolved pins and
 * messages. "New task" is here (and a tap on the map), nowhere else.
 *
 * A row the user may edit (its creator or an admin, `canEditTask`) has a ⋮
 * (#746, mockup 9): Edit opens the New task screen on it; Delete hides it at
 * once with the 6 s Undo and deletes it for the team when the Undo is gone.
 */
import { canCompleteTask, canEditTask, type TeamTask } from '@core/team/tasks';
import { shortAge } from '@core/teamui/positions';
import {
  anchorInfo,
  dueLabel,
  filterCounts,
  filterTasks,
  groupTasks,
  type TaskFilter,
} from '@core/teamui/tasks';
import { useUndoSnackbar } from '@features/common/useUndoSnackbar';
import { UndoBar } from '@features/library/selection/SelectionChrome';
import { teamService, useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Button, Icon, IconButton, Menu, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChoiceRow, MemberAvatar, SectionLabel, TeamScreenFrame, useNow } from './components';
import { useTeamMapFocus } from './map/teamMapFocus';
import { ResolvedItems } from './ResolvedItems';
import { taskStateLabel } from './TaskChip';
import { useAnchorLookup } from './useAnchorLookup';
import { useToggleTask } from './useToggleTask';

/** How long Delete's Undo stays (the app's 6 s). */
export const TASK_UNDO_MS = 6000;
/** The Undo bar's lift above the bottom inset: clear of the footer's button. */
const UNDO_LIFT = 76;

const ago = (ms: number) => {
  const a = shortAge(ms);
  return a === 'now' ? 'just now' : `${a} ago`;
};

export function TeamTasksScreen() {
  const t = useSchemeTokens();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const view = useTeamStore((s) => s.view);
  const allTasks = useTeamStore((s) => s.tasks);
  // Deleted here, Undo still offered: hidden now, deleted for the team when it goes.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const undo = useUndoSnackbar(TASK_UNDO_MS);
  const resolvedCount = useTeamStore((s) => s.resolved.size);
  const look = useAnchorLookup();
  const toggle = useToggleTask();
  const now = useNow(60_000);
  const [filter, setFilter] = useState<TaskFilter>('open');
  if (view === null) return <TeamScreenFrame title="Task list">{null}</TeamScreenFrame>;
  const tasks = hidden.size === 0 ? allTasks : allTasks.filter((x) => !hidden.has(keyOf(x)));

  const me = view.me;
  const myRole = view.members.find((m) => m.id === me)?.role;
  const byId = new Map(view.members.map((m) => [m.id, m]));
  const nameOf = (id: string) => (id === me ? 'You' : (byId.get(id)?.name ?? 'A teammate'));
  const counts = filterCounts(tasks, me);
  const groups = groupTasks(filterTasks(tasks, filter, me), me, nameOf);
  const canCreate = view.active && !view.readOnly && myRole !== undefined && myRole !== 'guest';

  const remove = (task: TeamTask) => {
    const key = keyOf(task);
    setHidden((h) => new Set(h).add(key));
    const unhide = () =>
      setHidden((h) => {
        const next = new Set(h);
        next.delete(key);
        return next;
      });
    undo.show({
      message: 'Task deleted',
      undo: unhide,
      commit: () => {
        teamService()?.active?.deleteTask(task.owner, task.id);
        useTeamStore.getState().refresh();
        unhide();
      },
    });
  };

  const row = (task: TeamTask) => {
    const where = anchorInfo(task.anchor, look);
    const allowed = canCompleteTask(task, me, myRole);
    const editable = view.active && !view.readOnly && canEditTask(task, me, myRole);
    const key = keyOf(task);
    const assignee = byId.get(task.assignee);
    const by = byId.get(task.owner);
    const at = where.at;
    return (
      <View
        key={key}
        style={[styles.task, { backgroundColor: t.surfaceVariant }]}
        testID="team-task-row"
      >
        <Pressable
          onPress={allowed ? () => toggle(task) : undefined}
          disabled={!allowed}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: task.done, disabled: !allowed }}
          accessibilityLabel={`${task.title}, ${taskStateLabel(task)}`}
          hitSlop={8}
          testID="team-task-check"
        >
          <Icon
            source={task.done ? 'checkbox-marked' : 'checkbox-blank-outline'}
            size={24}
            color={allowed ? t.ink : t.inkMuted}
          />
        </Pressable>
        <View style={styles.flex}>
          <Text
            variant="titleSmall"
            style={[{ color: t.ink }, task.done && [styles.doneText, { color: t.inkMuted }]]}
          >
            {task.title}
          </Text>
          <View style={styles.meta}>
            <Icon source="map-marker-outline" size={14} color={t.inkVariant} />
            <Text variant="bodySmall" style={[styles.flex, { color: t.inkVariant }]}>
              {`${where.label} · ${
                task.done && task.doneAt !== null
                  ? `done ${ago(now - task.doneAt)}`
                  : ago(now - task.createdAt)
              }`}
            </Text>
          </View>
          {task.due !== null && !task.done && (
            <View style={styles.meta}>
              <Icon
                source="clock-outline"
                size={14}
                color={task.due < now ? t.status.pausedInk : t.inkVariant}
              />
              <Text
                variant="bodySmall"
                style={{ color: task.due < now ? t.status.pausedInk : t.inkVariant }}
                testID="team-task-due"
              >
                {`Due ${dueLabel(task.due, now)}`}
              </Text>
            </View>
          )}
          {task.doneBeforeReassignment && (
            <Text variant="bodySmall" style={{ color: t.inkMuted }}>
              {`Completed by ${nameOf(task.doneBy ?? '')} before it was reassigned`}
            </Text>
          )}
          <View style={styles.meta}>
            {by && <MemberAvatar initials={by.initials} color={by.color} size={18} />}
            <Text variant="bodySmall" style={{ color: t.inkMuted }}>
              {`from ${task.owner === me ? 'you' : nameOf(task.owner)}`}
            </Text>
          </View>
        </View>
        <View style={styles.right}>
          {assignee && (
            <MemberAvatar initials={assignee.initials} color={assignee.color} size={30} />
          )}
          {at && (
            <IconButton
              icon="crosshairs-gps"
              size={20}
              onPress={() => {
                useTeamMapFocus.getState().focus(at[0], at[1]);
                router.navigate('/');
              }}
              accessibilityLabel={`Show “${task.title}” on the map`}
              testID="team-task-locate"
            />
          )}
        </View>
        {editable && (
          <Menu
            visible={menuFor === key}
            onDismiss={() => setMenuFor(null)}
            anchor={
              <IconButton
                icon="dots-vertical"
                size={22}
                iconColor={t.inkMuted}
                style={styles.menuButton}
                onPress={() => setMenuFor(key)}
                accessibilityLabel={`Options for “${task.title}”`}
                testID="team-task-menu"
              />
            }
          >
            <Menu.Item
              leadingIcon="pencil-outline"
              title="Edit"
              onPress={() => {
                setMenuFor(null);
                router.push(`/team/task-new?eo=${task.owner}&ei=${task.id}` as never);
              }}
              testID="team-task-edit"
            />
            <Menu.Item
              leadingIcon="delete-outline"
              title="Delete"
              onPress={() => {
                setMenuFor(null);
                remove(task);
              }}
              testID="team-task-delete"
            />
          </Menu>
        )}
      </View>
    );
  };

  return (
    <View style={styles.fill}>
      <TeamScreenFrame
        title="Task list"
        testID="team-tasks-screen"
        footer={
          canCreate ? (
            <Button
              mode="contained"
              icon="plus"
              onPress={() => router.push('/team/task-new' as never)}
              testID="team-task-new"
            >
              New task
            </Button>
          ) : undefined
        }
      >
        <ChoiceRow
          options={[
            { id: 'open', label: `Open · ${counts.open}` },
            { id: 'mine', label: `Mine · ${counts.mine}` },
            { id: 'all', label: `All · ${counts.all}` },
            { id: 'done', label: `Done · ${counts.done + resolvedCount}` },
          ]}
          value={filter}
          onChange={setFilter}
          testIDPrefix="team-task-filter"
        />
        {groups.length === 0 && (
          <Text variant="bodyMedium" style={{ color: t.inkVariant }}>
            {tasks.length === 0
              ? 'No tasks yet. Add one here, or write “+task @name what to do” in a comment.'
              : 'Nothing here.'}
          </Text>
        )}
        {groups.map((g) => (
          <View key={g.assignee} style={styles.group}>
            <SectionLabel>{g.assignee === me ? 'You' : nameOf(g.assignee)}</SectionLabel>
            {g.tasks.map(row)}
          </View>
        ))}
        {(filter === 'done' || filter === 'all') && <ResolvedItems />}
      </TeamScreenFrame>
      <UndoBar
        message={undo.message}
        onUndo={undo.undo}
        bottom={insets.bottom + UNDO_LIFT}
        testIDPrefix="team-task"
      />
    </View>
  );
}

const keyOf = (task: Pick<TeamTask, 'owner' | 'id'>) => `${task.owner}:${task.id}`;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1, gap: 3 },
  group: { gap: 8 },
  task: { flexDirection: 'row', gap: 12, padding: 12, borderRadius: 12, alignItems: 'flex-start' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  right: { alignItems: 'center', gap: 2 },
  doneText: { textDecorationLine: 'line-through' },
  menuButton: { margin: 0, marginRight: -8, marginTop: -6 },
});
