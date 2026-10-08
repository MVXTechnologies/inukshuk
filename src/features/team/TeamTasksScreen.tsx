/**
 * The task list (#589, mockup `d-task-list`; owner 2026-10-07: it replaces
 * "Resolved"): open tasks first; filters (open, mine, all, done), grouped by
 * person (me first), each with where it is anchored, its age and who gave it;
 * the box ticks it (creator, assignee or admin), the locate button flies the
 * map to its anchor. "Done" also lists the resolved pins and messages. "New
 * task" is here (and a tap on the map), nowhere else.
 */
import { canCompleteTask, type TeamTask } from '@core/team/tasks';
import { shortAge } from '@core/teamui/positions';
import {
  anchorInfo,
  filterCounts,
  filterTasks,
  groupTasks,
  type TaskFilter,
} from '@core/teamui/tasks';
import { useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Button, Icon, IconButton, Text } from 'react-native-paper';

import { ChoiceRow, MemberAvatar, SectionLabel, TeamScreenFrame, useNow } from './components';
import { useTeamMapFocus } from './map/teamMapFocus';
import { ResolvedItems } from './ResolvedItems';
import { taskStateLabel } from './TaskChip';
import { useAnchorLookup } from './useAnchorLookup';
import { useToggleTask } from './useToggleTask';

const ago = (ms: number) => {
  const a = shortAge(ms);
  return a === 'now' ? 'just now' : `${a} ago`;
};

export function TeamTasksScreen() {
  const t = useSchemeTokens();
  const router = useRouter();
  const view = useTeamStore((s) => s.view);
  const tasks = useTeamStore((s) => s.tasks);
  const resolvedCount = useTeamStore((s) => s.resolved.size);
  const look = useAnchorLookup();
  const toggle = useToggleTask();
  const now = useNow(60_000);
  const [filter, setFilter] = useState<TaskFilter>('open');
  if (view === null) return <TeamScreenFrame title="Task list">{null}</TeamScreenFrame>;

  const me = view.me;
  const myRole = view.members.find((m) => m.id === me)?.role;
  const byId = new Map(view.members.map((m) => [m.id, m]));
  const nameOf = (id: string) => (id === me ? 'You' : (byId.get(id)?.name ?? 'A teammate'));
  const counts = filterCounts(tasks, me);
  const groups = groupTasks(filterTasks(tasks, filter, me), me, nameOf);
  const canCreate = view.active && !view.readOnly && myRole !== undefined && myRole !== 'guest';

  const row = (task: TeamTask) => {
    const where = anchorInfo(task.anchor, look);
    const allowed = canCompleteTask(task, me, myRole);
    const assignee = byId.get(task.assignee);
    const by = byId.get(task.owner);
    const at = where.at;
    return (
      <View
        key={`${task.owner}:${task.id}`}
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
      </View>
    );
  };

  return (
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
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 3 },
  group: { gap: 8 },
  task: { flexDirection: 'row', gap: 12, padding: 12, borderRadius: 12, alignItems: 'flex-start' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  right: { alignItems: 'center', gap: 2 },
  doneText: { textDecorationLine: 'line-through' },
});
