/**
 * New task (#589) and Edit task (#746, mockup 10): what to do, notes, for
 * whom (members and up: guests can't be given tasks), where — the pin, photo
 * or place it was opened from (or the task's own place when editing), or
 * where I am, or nowhere — and when it is due. The same thing `+task @name …`
 * does in a comment. Editing opens this screen on a task (`eo`/`ei`), titled
 * "Edit task", footer Cancel / Save; only its creator or an admin gets here.
 */
import { KEYBOARD_DONE_BAR_ID, KeyboardDoneBar } from '@ui/components/KeyboardDoneBar';
import { canEditTask, MAX_TASK_NOTES, MAX_TASK_TITLE, type TaskAnchor } from '@core/team/tasks';
import {
  anchorInfo,
  dueLabel,
  DUE_STEP_MIN,
  inOneHour,
  pickStart,
  shiftDue,
} from '@core/teamui/tasks';
import { teamService, useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import * as Location from 'expo-location';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Button, Icon, IconButton, Text, TextInput } from '@ui/paper';

import { MemberAvatar, SectionLabel, TeamScreenFrame } from './components';
import { actionMessage } from './messages';
import { useTeamPick } from './map/TeamPick';
import { useAnchorLookup } from './useAnchorLookup';
import { useScaledStyles } from '@ui/displayScale';

type Place = 'given' | 'here' | 'none';
/** The Due chips: none, the time already set (editing), in an hour, picked. */
type DueChoice = 'none' | 'kept' | 'hour' | 'pick';

function anchorFromParams(p: Record<string, string | undefined>): TaskAnchor | null {
  const { ak, ao, ai, la, lo } = p;
  if ((ak === 'photo' || ak === 'pin' || ak === 'trail') && ao && ai)
    return { kind: ak, owner: ao, id: ai };
  const lat = Number(la);
  const lng = Number(lo);
  if (ak === 'point' && Number.isFinite(lat) && Number.isFinite(lng))
    return { kind: 'point', lat, lng };
  return null;
}

export function NewTaskScreen() {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const router = useRouter();
  const params = useLocalSearchParams<Record<string, string>>();
  const view = useTeamStore((s) => s.view);
  const editing = useTeamStore((s) =>
    params['eo'] && params['ei']
      ? s.tasks.find((x) => x.owner === params['eo'] && x.id === params['ei'])
      : undefined,
  );
  const editTarget =
    params['eo'] && params['ei'] ? { owner: params['eo'], id: params['ei'] } : null;
  const look = useAnchorLookup();
  // Back from "Attach to…": what was typed before, and the place just picked.
  const resumed = params['resume'] === '1';
  const draft = resumed ? useTeamPick.getState().draft : null;
  const given = resumed || !editing ? anchorFromParams(params) : editing.anchor;
  const [now] = useState(() => Date.now());
  const [title, setTitle] = useState(draft?.title ?? editing?.title ?? '');
  const [notes, setNotes] = useState(draft?.notes ?? editing?.notes ?? '');
  const [assignee, setAssignee] = useState<string | null>(
    draft?.assignee ??
      editing?.assignee ??
      (typeof params['to'] === 'string' ? params['to'] : null),
  );
  const [place, setPlace] = useState<Place>(
    given ? 'given' : params['ak'] === 'none' || editing ? 'none' : 'here',
  );
  const keptDue = (draft ? draft.due : editing?.due) ?? null;
  const [dueChoice, setDueChoice] = useState<DueChoice>(keptDue === null ? 'none' : 'kept');
  const [hourDue, setHourDue] = useState(() => inOneHour(now));
  const [pickedDue, setPickedDue] = useState(() => pickStart(keptDue, now));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const screenTitle = editTarget ? 'Edit task' : 'New task';
  if (view === null) return <TeamScreenFrame title={screenTitle}>{null}</TeamScreenFrame>;
  const myRole = view.members.find((m) => m.id === view.me)?.role;
  // A task that is gone, or one I may not edit: nothing to edit here.
  if (editTarget && (editing === undefined || !canEditTask(editing, view.me, myRole)))
    return <TeamScreenFrame title={screenTitle}>{null}</TeamScreenFrame>;

  const people = view.members.filter((m) => m.active && m.role !== 'guest');
  const due =
    dueChoice === 'none'
      ? null
      : dueChoice === 'kept'
        ? keptDue
        : dueChoice === 'hour'
          ? hourDue
          : pickedDue;

  const save = async () => {
    const session = teamService()?.active;
    if (!session || assignee === null) return;
    setBusy(true);
    let anchor: TaskAnchor | null = place === 'given' ? given : null;
    if (place === 'here') {
      try {
        const fix = await Location.getLastKnownPositionAsync();
        if (fix) anchor = { kind: 'point', lat: fix.coords.latitude, lng: fix.coords.longitude };
      } catch {
        // No position: the task has no place.
      }
    }
    const err =
      editing && editTarget
        ? session.updateTask(editing.owner, editing.id, { title, notes, assignee, due, anchor })
        : session.createTask({ title, notes, assignee, anchor, due });
    setBusy(false);
    useTeamStore.getState().refresh();
    if (err) setError(actionMessage(err));
    else router.back();
  };

  const placeChoices: { id: Place; label: string }[] = [
    ...(given ? [{ id: 'given' as const, label: anchorInfo(given, look).label }] : []),
    { id: 'here', label: 'Where I am' },
    { id: 'none', label: 'No place' },
  ];
  const attach = () => {
    useTeamPick.getState().start('task', { title, assignee, notes, due, edit: editTarget });
    router.navigate('/');
  };
  const dueChoices: { id: DueChoice; label: string; icon?: string }[] = [
    { id: 'none', label: 'None' },
    ...(keptDue !== null ? [{ id: 'kept' as const, label: dueLabel(keptDue, now) }] : []),
    { id: 'hour', label: 'In 1 h' },
    { id: 'pick', label: 'Pick…', icon: 'clock-outline' },
  ];
  const picked = dueLabel(pickedDue, now);
  const cut = picked.lastIndexOf(' ');
  const pickedDay = picked.slice(0, cut);
  const pickedTime = picked.slice(cut + 1);

  const chip = (on: boolean) => [
    styles.chip,
    {
      borderColor: on ? t.ink : t.outlineVariant,
      backgroundColor: on ? t.surfaceVariant : 'transparent',
    },
  ];
  const stepper = (
    label: string,
    a11y: [string, string],
    back: () => void,
    forward: () => void,
    id: string,
    icons: [string, string],
  ) => (
    <View style={styles.stepper}>
      <IconButton
        icon={icons[0]}
        size={20}
        onPress={back}
        accessibilityLabel={a11y[0]}
        testID={`team-task-due-${id}-back`}
      />
      <Text
        variant="labelLarge"
        style={[styles.stepValue, { color: t.ink }]}
        testID={`team-task-due-${id}`}
      >
        {label}
      </Text>
      <IconButton
        icon={icons[1]}
        size={20}
        onPress={forward}
        accessibilityLabel={a11y[1]}
        testID={`team-task-due-${id}-forward`}
      />
    </View>
  );

  return (
    <TeamScreenFrame
      title={screenTitle}
      testID={editTarget ? 'team-task-edit-screen' : 'team-task-new-screen'}
      footer={
        editTarget ? (
          <>
            <Button mode="text" onPress={() => router.back()} testID="team-task-cancel">
              Cancel
            </Button>
            <Button
              mode="contained"
              onPress={() => void save()}
              loading={busy}
              disabled={busy || title.trim().length === 0 || assignee === null}
              testID="team-task-save"
            >
              Save
            </Button>
          </>
        ) : (
          <Button
            mode="contained"
            onPress={() => void save()}
            loading={busy}
            disabled={busy || title.trim().length === 0 || assignee === null}
            testID="team-task-create"
          >
            Assign
          </Button>
        )
      }
    >
      <TextInput
        mode="outlined"
        label="What to do"
        value={title}
        onChangeText={setTitle}
        maxLength={MAX_TASK_TITLE}
        multiline
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        testID="team-task-title"
        inputAccessoryViewID={KEYBOARD_DONE_BAR_ID}
      />
      <TextInput
        mode="outlined"
        label="Notes"
        value={notes}
        onChangeText={setNotes}
        maxLength={MAX_TASK_NOTES}
        multiline
        testID="team-task-notes"
        inputAccessoryViewID={KEYBOARD_DONE_BAR_ID}
      />
      <KeyboardDoneBar />
      <SectionLabel>For</SectionLabel>
      <View style={styles.people}>
        {people.map((m) => {
          const on = assignee === m.id;
          return (
            <Pressable
              key={m.id}
              onPress={() => setAssignee(m.id)}
              style={chip(on)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={m.isMe ? 'Me' : m.name}
              testID={`team-task-for-${m.isMe ? 'me' : m.id}`}
            >
              <MemberAvatar initials={m.initials} color={m.color} size={26} />
              <Text variant="labelLarge" style={{ color: t.ink }}>
                {m.isMe ? 'Me' : m.name}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <SectionLabel>Where</SectionLabel>
      <View style={styles.people}>
        {placeChoices.map((c) => {
          const on = place === c.id;
          return (
            <Pressable
              key={c.id}
              onPress={() => setPlace(c.id)}
              style={chip(on)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              testID={`team-task-place-${c.id}`}
            >
              <Text variant="labelLarge" style={{ color: t.ink }}>
                {c.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Button
        mode="outlined"
        icon="map-marker-plus-outline"
        onPress={attach}
        testID="team-task-attach"
      >
        Attach to… a trail, a photo or the map
      </Button>
      <SectionLabel>Due</SectionLabel>
      <View style={styles.people}>
        {dueChoices.map((c) => {
          const on = dueChoice === c.id;
          return (
            <Pressable
              key={c.id}
              onPress={() => {
                if (c.id === 'hour') setHourDue(inOneHour(Date.now()));
                setDueChoice(c.id);
              }}
              style={chip(on)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              testID={`team-task-due-${c.id}`}
            >
              {c.icon ? <Icon source={c.icon} size={18} color={t.ink} /> : null}
              <Text variant="labelLarge" style={{ color: t.ink }}>
                {c.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {dueChoice === 'pick' && (
        <View
          style={[styles.picker, { borderColor: t.outlineVariant }]}
          testID="team-task-due-picker"
        >
          {stepper(
            pickedDay,
            ['Previous day', 'Next day'],
            () => setPickedDue((d) => shiftDue(d, { days: -1 }, Date.now())),
            () => setPickedDue((d) => shiftDue(d, { days: 1 }, Date.now())),
            'day',
            ['chevron-left', 'chevron-right'],
          )}
          {stepper(
            pickedTime,
            [`${DUE_STEP_MIN} minutes earlier`, `${DUE_STEP_MIN} minutes later`],
            () => setPickedDue((d) => shiftDue(d, { minutes: -DUE_STEP_MIN }, Date.now())),
            () => setPickedDue((d) => shiftDue(d, { minutes: DUE_STEP_MIN }, Date.now())),
            'time',
            ['minus', 'plus'],
          )}
        </View>
      )}
      {error !== null && (
        <Text variant="bodySmall" style={{ color: t.status.gpsLostInk }}>
          {error}
        </Text>
      )}
    </TeamScreenFrame>
  );
}

const stylesSheet = StyleSheet.create({
  people: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 40,
  },
  picker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 4,
  },
  stepper: { flexDirection: 'row', alignItems: 'center' },
  stepValue: { minWidth: 72, textAlign: 'center' },
});
