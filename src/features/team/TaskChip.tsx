/**
 * A task as a chip (#589, mockups `c-photo-task`, `b-map-pin`): under the
 * comment it was made from. Its box ticks it when I may (the creator, the
 * assignee, an admin); otherwise it only shows the state.
 */
import type { TeamTask } from '@core/team/tasks';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet } from 'react-native';
import { Icon, Text } from 'react-native-paper';

export function taskStateLabel(task: TeamTask): string {
  if (!task.done) return 'open';
  return task.doneBeforeReassignment ? 'done before reassignment' : 'done';
}

export function TaskChip({
  task,
  assigneeName,
  canToggle,
  onToggle,
}: {
  task: TeamTask;
  assigneeName: string;
  canToggle: boolean;
  onToggle: () => void;
}) {
  const t = useSchemeTokens();
  const label = `Task · ${assigneeName} · ${taskStateLabel(task)}`;
  return (
    <Pressable
      onPress={canToggle ? onToggle : undefined}
      disabled={!canToggle}
      style={[styles.chip, { borderColor: t.outline, backgroundColor: t.surfaceVariant }]}
      accessibilityRole={canToggle ? 'checkbox' : 'text'}
      accessibilityState={{ checked: task.done, disabled: !canToggle }}
      accessibilityLabel={`${label}: ${task.title}`}
      testID="team-task-chip"
    >
      <Icon
        source={task.done ? 'checkbox-marked' : 'checkbox-blank-outline'}
        size={16}
        color={t.ink}
      />
      <Text variant="labelMedium" style={{ color: t.ink }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginTop: 6,
    maxWidth: '100%',
  },
});
