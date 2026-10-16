/**
 * The task list (#589, mockup `d-task-list`; owner 2026-10-07: it replaces
 * "Resolved"): open tasks first; filters (open, mine, all, done), grouped by
 * person (me first), each with where it is anchored, when it is due, its age
 * and who gave it; the box ticks it (creator, assignee or admin), the locate
 * button flies the map to its anchor. "Done" also lists the resolved pins and
 * messages. "New task" is here (and a tap on the map), nowhere else.
 *
 * #757 (owner): compact rows. The box, the title (up to two lines), then one
 * line: where (a tap shows it on the map) · due (amber once late) · from
 * whom. A row the user may edit (its creator or an admin, `canEditTask`)
 * shows Edit and Delete as visible buttons, no ⋮ menu: Edit opens the New
 * task screen on it; Delete hides it at once with the 6 s Undo and deletes it
 * for the team when the Undo is gone. The assignee is the section's header,
 * so the row no longer repeats their avatar.
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
import { Button, Icon, IconButton, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChoiceRow, SectionLabel, TeamScreenFrame, useNow } from './components';
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
    const at = where.at;
    const late = task.due !== null && !task.done && task.due < now;
    const from = `from ${task.owner === me ? 'you' : nameOf(task.owner)}`;
    return (
      <View
        key={key}
        style={[styles.task, { borderBottomColor: t.outlineVariant }]}
        testID="team-task-row"
      >
        <Pressable
          onPress={allowed ? () => toggle(task) : undefined}
          disabled={!allowed}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: task.done, disabled: !allowed }}
          accessibilityLabel={`${task.title}, ${taskStateLabel(task)}`}
          hitSlop={8}
          style={styles.check}
          testID="team-task-check"
        >
          <Icon
            source={task.done ? 'checkbox-marked' : 'checkbox-blank-outline'}
            size={24}
            color={allowed ? t.ink : t.inkMuted}
          />
        </Pressable>
        <View style={styles.text}>
          <Text
            variant="titleSmall"
            style={[{ color: t.ink }, task.done && [styles.doneText, { color: t.inkMuted }]]}
            numberOfLines={2}
          >
            {task.title}
          </Text>
          {/* One line of facts, wrapping only when the font is very large. */}
          <Text variant="bodySmall" style={{ color: t.inkVariant }} testID="team-task-meta">
            {at ? (
              <Text
                style={styles.place}
                onPress={() => {
                  useTeamMapFocus.getState().focus(at[0], at[1]);
                  router.navigate('/');
                }}
                accessibilityRole="link"
                accessibilityLabel={`Show “${task.title}” on the map`}
                testID="team-task-locate"
              >
                {where.label}
              </Text>
            ) : (
              where.label
            )}
            {task.due !== null && !task.done && (
              <Text
                style={late && [styles.late, { color: t.status.pausedInk }]}
                testID="team-task-due"
              >
                {` · due ${dueLabel(task.due, now)}`}
              </Text>
            )}
            {task.done && task.doneAt !== null ? ` · done ${ago(now - task.doneAt)}` : ''}
            {` · ${from}`}
          </Text>
          {task.doneBeforeReassignment && (
            <Text variant="bodySmall" style={{ color: t.inkMuted }}>
              {`Completed by ${nameOf(task.doneBy ?? '')} before it was reassigned`}
            </Text>
          )}
        </View>
        {editable && (
          <>
            <IconButton
              icon="pencil-outline"
              size={20}
              iconColor={t.inkVariant}
              style={styles.action}
              onPress={() => router.push(`/team/task-new?eo=${task.owner}&ei=${task.id}` as never)}
              accessibilityLabel={`Edit “${task.title}”`}
              testID="team-task-edit"
            />
            <IconButton
              icon="delete-outline"
              size={20}
              iconColor={t.inkVariant}
              style={styles.action}
              onPress={() => remove(task)}
              accessibilityLabel={`Delete “${task.title}”`}
              testID="team-task-delete"
            />
          </>
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
          oneLine
          options={[
            { id: 'open', label: 'Open', count: counts.open },
            { id: 'mine', label: 'Mine', count: counts.mine },
            { id: 'all', label: 'All', count: counts.all },
            { id: 'done', label: 'Done', count: counts.done + resolvedCount },
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
  group: { gap: 0 },
  // A list row (#757): about 56–64 dp, a hairline under it, no card.
  task: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 56,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  check: { alignSelf: 'center' },
  text: { flex: 1, minWidth: 0, gap: 2 },
  place: { textDecorationLine: 'underline' },
  late: { fontWeight: '700' },
  doneText: { textDecorationLine: 'line-through' },
  // 40 dp targets, flush with the row's end.
  action: { margin: 0, width: 40, height: 40 },
});
